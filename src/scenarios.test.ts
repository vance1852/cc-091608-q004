import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FallSignal } from "./contracts.ts";
import { assessSignal, DEFAULT_POLICY, evaluateCancel, isInQuietHours, type FamilyPolicy } from "./policy.ts";
import { ScriptedProvider, type NotificationProvider } from "./provider.ts";
import { RescueOrchestrator } from "./orchestrator.ts";
import { InMemoryStore, JsonFileStore, type StateStore } from "./store.ts";
import { VirtualTimer } from "./timers.ts";
import { replayFixtures } from "./replay.ts";

const T0 = "2026-09-15T10:30:00+08:00";

function signal(partial: Partial<FallSignal> & Pick<FallSignal, "eventId" | "receivedAt">): FallSignal {
  return {
    wearerId: "elder-08",
    capturedAt: partial.receivedAt,
    impactG: 1.2,
    postureChanged: false,
    stillSeconds: 0,
    worn: true,
    locationToken: `loc-${partial.eventId}`,
    ...partial,
  };
}

function after(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

async function newOrchestrator(
  store: StateStore,
  timer: VirtualTimer,
  provider?: NotificationProvider,
  policy: FamilyPolicy = DEFAULT_POLICY,
) {
  return RescueOrchestrator.create(store, policy, provider ?? new ScriptedProvider(), timer);
}

describe("风险分级", () => {
  it("离腕设备不升级为高风险事件", () => {
    const a = assessSignal(signal({ eventId: "x", receivedAt: T0, worn: false, impactG: 4.5 }), DEFAULT_POLICY);
    assert.equal(a.risk, "off-wrist");
    assert.deepEqual(a.features, []);
  });

  it("强冲击、长静止、长离线补传任一成立即为高风险", () => {
    const impact = assessSignal(signal({ eventId: "a", receivedAt: T0, impactG: 3.2 }), DEFAULT_POLICY);
    assert.equal(impact.risk, "high");
    assert.ok(impact.features.includes("impact:3.2g"));

    const still = assessSignal(
      signal({ eventId: "b", receivedAt: T0, postureChanged: true, stillSeconds: 90 }),
      DEFAULT_POLICY,
    );
    assert.equal(still.risk, "high");
    assert.ok(still.features.some((f) => f.startsWith("posture-change+still")));

    const offline = assessSignal(
      signal({
        eventId: "c",
        capturedAt: "2026-09-15T09:10:00+08:00",
        receivedAt: "2026-09-15T12:40:00+08:00",
      }),
      DEFAULT_POLICY,
    );
    assert.equal(offline.risk, "high");
    assert.ok(offline.features.includes("offline-delay:210min"));
  });

  it("静默时段按联系人时区判定且可跨午夜", () => {
    const rule = DEFAULT_POLICY.contacts[0]!; // daughter 23:00-07:00
    assert.equal(isInQuietHours(rule, "2026-09-15T00:30:00+08:00", "Asia/Shanghai"), true);
    assert.equal(isInQuietHours(rule, "2026-09-15T12:00:00+08:00", "Asia/Shanghai"), false);
  });

  it("普通取消只在时限内对非高风险告警有效", () => {
    const deadline = after(T0, 60);
    assert.equal(evaluateCancel("normal", [], deadline, after(T0, 30)).accepted, true);
    assert.equal(evaluateCancel("normal", [], deadline, after(T0, 61)).accepted, false);
    const high = evaluateCancel("high", ["impact:3.9g"], deadline, after(T0, 5));
    assert.equal(high.accepted, false);
    if (!high.accepted) assert.equal(high.reason, "high-risk");
  });
});

describe("事件去重与时间线", () => {
  it("同 eventId 的重传/补传包只计数，不产生新时间线", async () => {
    const store = new InMemoryStore();
    const timer = new VirtualTimer(T0);
    const orch = await newOrchestrator(store, timer);
    await orch.ingest(signal({ eventId: "e1", receivedAt: T0 }));
    await timer.advanceTo(after(T0, 5));
    await orch.ingest(signal({ eventId: "e1", receivedAt: after(T0, 5), impactG: 5.0 }));
    await orch.ingest(signal({ eventId: "e1", receivedAt: after(T0, 9) }));

    const view = orch.getEvent("e1")!;
    assert.equal(view.event.duplicateCount, 2);
    // 晚到包的高冲击不得覆盖首包质量信息。
    assert.equal(view.event.signal.impactG, 1.2);
    assert.equal(view.timeline.length, 2);
    const ids = view.timeline.map((t) => t.entryId);
    assert.deepEqual(ids, ["rescue-e1-001", "rescue-e1-002"]);
  });

  it("重复查询返回唯一且顺序稳定的时间线", async () => {
    const { views } = await replayFixtures();
    const order = views.map((v) => v.event.eventId);
    assert.deepEqual(order, ["fall-1", "fall-2", "fall-3"]);
    for (const v of views) {
      const ids1 = v.timeline.map((t) => t.entryId);
      assert.equal(new Set(ids1).size, ids1.length, "entryId 唯一");
      const parsed = v.timeline.map((t) => Date.parse(t.occurredAt));
      assert.deepEqual(parsed, [...parsed].sort((a, b) => a - b), "时间线按发生时刻排序");
      // 再查一次，结果完全一致（稳定）。
      assert.deepEqual(v.timeline.map((t) => t.entryId), ids1);
    }
    // +08:00 与 Z 混用不得打乱顺序（fall-3 首条是 +08:00 写法，其余为 Z）。
    const f3 = views.find((v) => v.event.eventId === "fall-3")!;
    assert.equal(f3.timeline[0]!.reasonCode, "signal-received");
    assert.equal(f3.timeline.at(-1)!.reasonCode, "contact-confirmed");
  });
});

describe("误触取消", () => {
  it("离腕事件在询问窗口内可由佩戴者取消，晚到重传不复活告警", async () => {
    const { views } = await replayFixtures();
    const v = views.find((x) => x.event.eventId === "fall-1")!;
    assert.equal(v.state, "resolved");
    assert.equal(v.event.resolution, "wearer-cancel");
    assert.equal(v.event.duplicateCount, 1);
    const codes = v.timeline.map((t) => t.reasonCode);
    assert.deepEqual(codes, ["signal-received", "ask-started", "wearer-cancel-accepted"]);
  });

  it("高风险告警的普通取消被拒，联系人链继续；超时后的取消同样被拒", async () => {
    const store = new InMemoryStore();

    // 高风险：在窗口内取消 -> 拒绝 high-risk。
    const t1 = new VirtualTimer(T0);
    const o1 = await newOrchestrator(store, t1);
    await o1.ingest(signal({ eventId: "h1", receivedAt: T0, impactG: 3.9 }));
    await t1.advanceTo(after(T0, 10));
    const r1 = await o1.cancelByWearer("h1");
    assert.deepEqual(r1, { accepted: false, reason: "high-risk" });
    assert.notEqual(o1.getEvent("h1")!.state, "resolved");

    // 普通风险：超过 60s 取消时限后取消 -> 拒绝 window-expired（询问 30s 已超时进入联系人阶段）。
    const t2 = new VirtualTimer(T0);
    const o2 = await newOrchestrator(new InMemoryStore(), t2);
    await o2.ingest(signal({ eventId: "n1", receivedAt: T0 }));
    await t2.advanceTo(after(T0, 61));
    assert.equal(o2.getEvent("n1")!.state, "contacting");
    const r2 = await o2.cancelByWearer("n1");
    assert.deepEqual(r2, { accepted: false, reason: "window-expired" });
  });
});

describe("无人响应与急救升级", () => {
  it("提供商失败重试汇入同一救援链，联系人全部超时后升级急救", async () => {
    const store = new InMemoryStore();
    const timer = new VirtualTimer(T0);
    const provider = new ScriptedProvider({ "u1:daughter": [1] });
    const orch = await newOrchestrator(store, timer, provider);
    await orch.ingest(signal({ eventId: "u1", receivedAt: T0, postureChanged: true, stillSeconds: 90 }));

    await timer.advanceTo(after(T0, 411));
    const v = orch.getEvent("u1")!;
    assert.equal(v.state, "emergency");
    assert.equal(v.currentResponderId, DEFAULT_POLICY.emergencyResponderId);

    const codes = v.timeline.map((t) => t.reasonCode);
    assert.deepEqual(codes.filter((c) => c === "delivery-retry").length, 1);
    assert.deepEqual(codes.filter((c) => c === "contact-timeout").length, 3);
    assert.ok(codes.includes("emergency-escalation"));
    assert.ok(codes.includes("emergency-dispatch"));

    // 第一次呼叫失败、第二次成功，均针对女儿、同一 rescueId。
    const daughterSends = provider.sent.filter((s) => s.recipientId === "daughter");
    assert.deepEqual(daughterSends.map((s) => [s.attempt, s.rescueId]), [
      [1, "rescue-u1"],
      [2, "rescue-u1"],
    ]);
    // 每次升级原因都可查。
    assert.ok(v.escalations.some((e) => e.reason === "emergency-escalation"));
  });

  it("急救呼叫持续重试直到受理，受理后可由急救方结束救援链", async () => {
    const timer = new VirtualTimer(T0);
    const emId = DEFAULT_POLICY.emergencyResponderId;
    const provider = new ScriptedProvider({ [`z1:${emId}`]: [1, 2] });
    const orch = await newOrchestrator(new InMemoryStore(), timer, provider);
    await orch.ingest(signal({ eventId: "z1", receivedAt: T0, postureChanged: true, stillSeconds: 90 }));
    // 三个联系人各 120s 窗口 + 两次急救重试间隔。
    await timer.advanceTo(after(T0, 30 + 3 * 120 + 2 * DEFAULT_POLICY.retryDelaySeconds + 1));

    const v = orch.getEvent("z1")!;
    assert.equal(v.state, "emergency");
    const retries = v.timeline.filter((t) => t.reasonCode === "delivery-retry");
    assert.equal(retries.length, 2);
    assert.ok(v.timeline.some((t) => t.reasonCode === "emergency-dispatch"));

    const ack = await orch.acknowledgeEmergency("z1");
    assert.deepEqual(ack, { accepted: true });
    const done = orch.getEvent("z1")!;
    assert.equal(done.state, "resolved");
    assert.equal(done.event.resolution, "emergency-handled");
  });

  it("提供商抛异常（网络层）与结构化失败一样进入重试链", async () => {
    const timer = new VirtualTimer(T0);
    const throwing: NotificationProvider = {
      async send(req) {
        if (req.recipientId === "daughter" && req.attempt === 1) {
          throw new Error("ECONNRESET");
        }
        return { outcome: "delivered", receiptId: `rcpt-${req.attempt}` };
      },
    };
    const orch = await newOrchestrator(new InMemoryStore(), timer, throwing);
    await orch.ingest(signal({ eventId: "t1", receivedAt: T0, impactG: 3.5 }));
    await timer.advanceTo(after(T0, 51));
    const v = orch.getEvent("t1")!;
    assert.equal(v.state, "contacting");
    assert.equal(v.currentResponderId, "daughter");
    assert.ok(v.timeline.some((e) => e.reasonCode === "delivery-retry"));
    assert.ok(v.escalations.some((e) => e.reason === "delivery-failed"));
  });

  it("静默时段只跳过该联系人，救援立即顺延", async () => {
    const quietStart = "2026-09-15T00:30:00+08:00"; // 女儿 23:00-07:00 静默中
    const timer = new VirtualTimer(quietStart);
    const orch = await newOrchestrator(new InMemoryStore(), timer);
    await orch.ingest(signal({ eventId: "q1", receivedAt: quietStart, impactG: 3.5 }));
    await timer.advanceTo(after(quietStart, 31));

    const v = orch.getEvent("q1")!;
    assert.equal(v.state, "contacting");
    assert.equal(v.currentResponderId, "son");
    assert.ok(v.timeline.some((t) => t.reasonCode === "contact-skipped-quiet" && t.actorId === "daughter"));
    assert.ok(v.timeline.some((t) => t.reasonCode === "contact-notify" && t.actorId === "son"));
  });
});

describe("离线补传", () => {
  it("210 分钟延迟构成高风险，普通取消被拒后由联系人确认结束", async () => {
    const { views } = await replayFixtures();
    const v = views.find((x) => x.event.eventId === "fall-3")!;
    assert.equal(v.event.risk, "high");
    assert.ok(v.event.highRiskFeatures.includes("offline-delay:210min"));
    assert.equal(v.event.duplicateCount, 1);
    assert.equal(v.state, "resolved");
    assert.equal(v.event.resolution, "contact-confirmed");
    const rejected = v.timeline.find((t) => t.reasonCode === "wearer-cancel-rejected");
    assert.ok(rejected);
    assert.ok(rejected!.reason.includes("高风险"));
    assert.ok(v.escalations.some((e) => e.reason === "cancel-rejected"));
  });
});

describe("位置短时开放与读取留痕", () => {
  it("只有当前响应人在授权窗口内可读，切换与过期均拒绝且留痕", async () => {
    const policy: FamilyPolicy = { ...DEFAULT_POLICY, locationGrantSeconds: 60 };
    const store = new InMemoryStore();
    const timer = new VirtualTimer(T0);
    const orch = await newOrchestrator(store, timer, undefined, policy);
    await orch.ingest(signal({ eventId: "l1", receivedAt: T0, impactG: 3.5 }));
    await timer.advanceTo(after(T0, 31)); // 女儿成为当前响应人并获授权

    assert.equal((await orch.readLocation("l1", "daughter")).allowed, true);
    assert.equal((await orch.readLocation("l1", "son")).reason, "not-current-responder");

    await timer.advanceTo(after(T0, 100)); // 授权 60s 过期，但女儿确认窗口未到
    assert.equal((await orch.readLocation("l1", "daughter")).reason, "expired");

    await timer.advanceTo(after(T0, 152)); // 女儿超时，儿子接手
    assert.equal((await orch.readLocation("l1", "son")).allowed, true);
    assert.equal((await orch.readLocation("l1", "daughter")).reason, "revoked");

    const log = orch.locationAccessLog("l1");
    assert.equal(log.length, 5);
    assert.deepEqual(log.map((r) => r.allowed), [true, false, false, true, false]);

    // 重新实例化（重启）后留痕仍在，且每次读取都已随事务落盘。
    const reloaded = await newOrchestrator(store, new VirtualTimer(after(T0, 200)), undefined, policy);
    const persisted = reloaded.locationAccessLog("l1");
    assert.equal(persisted.length, 5);
    assert.deepEqual(persisted.map((r) => [r.readerId, r.allowed, r.reason]), [
      ["daughter", true, "ok"],
      ["son", false, "not-current-responder"],
      ["daughter", false, "expired"],
      ["son", true, "ok"],
      ["daughter", false, "revoked"],
    ]);
  });
});

describe("重启恢复", () => {
  it("进程在联系人窗口期间重启，到期动作按持久化状态继续补跑", async () => {
    const store = new InMemoryStore();
    const timer1 = new VirtualTimer(T0);
    const o1 = await newOrchestrator(store, timer1);
    await o1.ingest(signal({ eventId: "r1", receivedAt: T0, impactG: 3.5 }));
    await timer1.advanceTo(after(T0, 100)); // 女儿窗口进行中（170s 才超时）
    assert.equal(o1.getEvent("r1")!.state, "contacting");
    const pendingToken = o1.getEvent("r1")!.event.pending?.token;
    assert.ok(pendingToken);

    // 模拟进程停机很久后重启：新时钟直接跳到 1000s，过期的女儿超时立即补跑；
    // 后续儿子、社区医生的确认窗口自恢复时刻重新起算，级联升级到急救。
    const timer2 = new VirtualTimer(after(T0, 1000));
    const o2 = await newOrchestrator(store, timer2, new ScriptedProvider());
    assert.equal(o2.getEvent("r1")!.event.pending?.token, pendingToken, "恢复同一持久化动作");
    await timer2.advanceTo(after(T0, 1000 + 2 * DEFAULT_POLICY.contactTimeoutSeconds + 1));

    const v = o2.getEvent("r1")!;
    assert.equal(v.state, "emergency");
    assert.equal(v.currentResponderId, DEFAULT_POLICY.emergencyResponderId);
    assert.ok(v.timeline.some((t) => t.reasonCode === "emergency-dispatch"));
  });

  it("JSON 文件存储在全新实例（模拟新进程）后恢复同一条救援链", async () => {
    const { rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(tmpdir(), `fall-rescue-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      // 进程一：收到高风险信号，推进到联系人窗口进行中。
      const store1 = new JsonFileStore(path);
      const timer1 = new VirtualTimer(T0);
      const o1 = await newOrchestrator(store1, timer1);
      await o1.ingest(signal({ eventId: "d1", receivedAt: T0, impactG: 3.9 }));
      await timer1.advanceTo(after(T0, 40));
      assert.equal(o1.getEvent("d1")!.state, "contacting");

      // 进程二：全新编排器实例从同一文件恢复，时钟跳到很久以后并跑完链路。
      const timer2 = new VirtualTimer(after(T0, 5000));
      const o2 = await newOrchestrator(new JsonFileStore(path), timer2, new ScriptedProvider());
      assert.equal(o2.getEvent("d1")!.event.signal.impactG, 3.9);
      assert.equal(o2.getEvent("d1")!.event.duplicateCount, 0);
      await timer2.advanceTo(after(T0, 5000 + 3 * DEFAULT_POLICY.contactTimeoutSeconds + 1));
      const v = o2.getEvent("d1")!;
      assert.equal(v.state, "emergency");
      assert.equal(v.currentResponderId, DEFAULT_POLICY.emergencyResponderId);
      // 时间线从进程一的两条（收到/询问）无缝接续，entryId 连续。
      const seq = v.timeline.map((t) => t.entryId);
      assert.deepEqual(seq.slice(0, 2), ["rescue-d1-001", "rescue-d1-002"]);
      assert.equal(new Set(seq).size, seq.length);
    } finally {
      await rm(path, { force: true });
    }
  });
});
