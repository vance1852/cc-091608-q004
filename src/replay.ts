import { readFile } from "node:fs/promises";
import type { EventView, FallSignal, LocationAccessRecord } from "./contracts.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import { ScriptedProvider } from "./provider.ts";
import { RescueOrchestrator } from "./orchestrator.ts";
import { InMemoryStore, type StateStore } from "./store.ts";
import { VirtualTimer } from "./timers.ts";

/** fixtures/fall-scenarios.json 的脱敏结构（只含关键字段，其余信号量采用回放默认值）。 */
interface FixtureScenario {
  name: string;
  eventId: string;
  worn: boolean;
  /** 相对采集时刻的接收延迟（秒）；未给 capturedAt/receivedAt 时使用。 */
  receivedDelaySeconds?: number;
  stillSeconds?: number;
  /** 家属/联系人响应情况：[] 表示整条联系人链无人确认。 */
  responses?: unknown[];
  capturedAt?: string;
  receivedAt?: string;
  impactG?: number;
  postureChanged?: boolean;
}

interface FixtureFile {
  wearerId: string;
  scenarios: FixtureScenario[];
}

export interface ReplayResult {
  fixture: FixtureFile;
  /** 最终查询会话中的事件视图（按首次收到时间稳定排序）。 */
  views: EventView[];
  accessLog: LocationAccessRecord[];
  provider: ScriptedProvider;
}

const DAY_BASE = "2026-09-15T08:30:00+08:00";

/**
 * 把 fixtures 的三段经过回放成可检查的救援链。
 *
 * 每段场景都用"新建编排器 + 载入同一持久化存储"开始，等价于服务重启后继续工作：
 * 会话一误触取消（离腕）、会话二无人响应（提供商重试一次后仍全部超时、升级急救）、
 * 会话三离线补传的旧事件晚到（210 分钟延迟构成高风险，普通取消被拒）。
 */
export async function replayFixtures(store?: StateStore): Promise<ReplayResult> {
  const fixturePath = new URL("../fixtures/fall-scenarios.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as FixtureFile;
  const byId = new Map(fixture.scenarios.map((s) => [s.eventId, s]));

  const stateStore = store ?? new InMemoryStore();

  // 会话一：误触取消（设备落在沙发上）。
  {
    const f1 = byId.get("fall-1")!;
    const timer = new VirtualTimer(DAY_BASE);
    const provider = new ScriptedProvider();
    const orch = await RescueOrchestrator.create(stateStore, DEFAULT_POLICY, provider, timer);

    const capturedAt = DAY_BASE;
    const receivedAt = isoAfter(capturedAt, f1.receivedDelaySeconds ?? 0);
    await orch.ingest(buildSignal(fixture.wearerId, f1, capturedAt, receivedAt, 0));
    // 10 秒内佩戴者取消（在 30 秒询问窗口与 60 秒取消时限之内）。
    await timer.advanceTo(isoAfter(receivedAt, 10));
    const cancel = await orch.cancelByWearer("fall-1");
    if (!cancel.accepted) throw new Error("fall-1 cancel should be accepted");
    // 告警关闭后设备链路层的重复包才晚到——必须被去重，时间线不再变化。
    await timer.advanceTo(isoAfter(receivedAt, 30));
    const dup = await orch.ingest(buildSignal(fixture.wearerId, f1, capturedAt, isoAfter(receivedAt, 30), 0));
    if (!dup.duplicate) throw new Error("fall-1 retransmission should be deduplicated");
  }

  // 会话二：真正摔倒，无人响应（服务重新启动，从持久化状态继续）。
  let provider2: ScriptedProvider;
  {
    const f2 = byId.get("fall-2")!;
    const base = "2026-09-15T10:30:00+08:00";
    const timer = new VirtualTimer(base);
    // 女儿的第一次语音呼叫被提供商丢弃，20 秒后重试成功——回执与重试汇入同一救援链。
    provider2 = new ScriptedProvider({ "fall-2:daughter": [1] });
    const orch = await RescueOrchestrator.create(stateStore, DEFAULT_POLICY, provider2, timer);

    await orch.ingest(buildSignal(fixture.wearerId, f2, base, base, 90));
    // 上行通道重传造成的重复包在询问期间到达。
    await timer.advanceTo(isoAfter(base, 45));
    const dup = await orch.ingest(buildSignal(fixture.wearerId, f2, base, isoAfter(base, 45), 90));
    if (!dup.duplicate) throw new Error("fall-2 retransmission should be deduplicated");

    // 30s 询问超时 -> 女儿首次投递失败 -> 50s 重试送达。
    await timer.advanceTo(isoAfter(base, 50));
    // 女儿读取位置：允许；儿子（尚不是响应人）同令牌读取：拒绝并留痕。
    const daughterRead = await orch.readLocation("fall-2", "daughter", timer.now());
    if (!daughterRead.allowed) throw new Error("daughter should read location while current responder");
    const sonEarlyRead = await orch.readLocation("fall-2", "son", timer.now());
    if (sonEarlyRead.reason !== "not-current-responder") {
      throw new Error("son must not read before becoming responder");
    }

    // 女儿 120s 确认窗口超时（50+120=170s）-> 儿子送达 -> 超时（290s）
    // -> 社区医生送达 -> 超时（410s）-> 升级急救并受理。
    await timer.advanceTo(isoAfter(base, 171));
    const sonRead = await orch.readLocation("fall-2", "son", timer.now());
    if (!sonRead.allowed) throw new Error("son should read location after escalation to him");
    await timer.advanceTo(isoAfter(base, 411));
    const view = orch.getEvent("fall-2");
    if (view?.state !== "emergency" || view.currentResponderId !== DEFAULT_POLICY.emergencyResponderId) {
      throw new Error("fall-2 should be escalated to emergency with no contact responding");
    }
  }

  // 会话三：离线补传的旧事件在第二天处理顺序中"晚到"（其时间戳停留在 09-15）。
  {
    const f3 = byId.get("fall-3")!;
    if (!f3.capturedAt || !f3.receivedAt) throw new Error("fall-3 requires timestamps");
    const timer = new VirtualTimer(f3.receivedAt);
    const provider = new ScriptedProvider();
    const orch = await RescueOrchestrator.create(stateStore, DEFAULT_POLICY, provider, timer);

    await orch.ingest(buildSignal(fixture.wearerId, f3, f3.capturedAt, f3.receivedAt, 0));
    // 补传通道的重复投递 5 秒后到达。
    await timer.advanceTo(isoAfter(f3.receivedAt, 5));
    const dup = await orch.ingest(buildSignal(fixture.wearerId, f3, f3.capturedAt, isoAfter(f3.receivedAt, 5), 0));
    if (!dup.duplicate) throw new Error("fall-3 backfill duplicate should be deduplicated");

    // 29 秒时佩戴者试图普通取消：在时限内，但高风险（离线 210 分钟）不允许关闭。
    await timer.advanceTo(isoAfter(f3.receivedAt, 29));
    const cancel = await orch.cancelByWearer("fall-3");
    if (cancel.accepted || cancel.reason !== "high-risk") {
      throw new Error("high-risk offline alarm must reject plain cancel");
    }
    // 询问窗口到期，女儿被呼叫并确认接手。
    await timer.advanceTo(isoAfter(f3.receivedAt, 31));
    const confirmed = await orch.confirmByContact("fall-3", "daughter");
    if (!confirmed.accepted) throw new Error("daughter should confirm the high-risk alarm");
  }

  // 最终查询会话：服务再次启动，家属查询三个样例。
  {
    const timer = new VirtualTimer("2026-09-15T13:00:00+08:00");
    const provider = new ScriptedProvider();
    const orch = await RescueOrchestrator.create(stateStore, DEFAULT_POLICY, provider, timer);
    const views = orch.listEvents();
    return { fixture, views, accessLog: orch.locationAccessLog(), provider: provider2! };
  }
}

function buildSignal(
  wearerId: string,
  scenario: FixtureScenario,
  capturedAt: string,
  receivedAt: string,
  defaultStill: number,
): FallSignal {
  const stillSeconds = scenario.stillSeconds ?? defaultStill;
  return {
    eventId: scenario.eventId,
    wearerId,
    capturedAt,
    receivedAt,
    impactG: scenario.impactG ?? (stillSeconds >= DEFAULT_POLICY.thresholds.stillSeconds ? 2.1 : 1.2),
    // 候选跌倒伴随长静止时，姿态变化判据同步成立（真实跌倒样例）。
    postureChanged: scenario.postureChanged ?? stillSeconds >= DEFAULT_POLICY.thresholds.stillSeconds,
    stillSeconds,
    worn: scenario.worn,
    locationToken: `loc-${scenario.eventId}`,
  };
}

function isoAfter(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
