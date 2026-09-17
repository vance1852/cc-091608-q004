/**
 * 三段经过的确定性回放：误触取消、无人响应（含提供商重试与中途重启）、离线补传。
 *
 * 运行：node src/demo.ts   （Node 22 原生执行 TypeScript）
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContactRule, FallSignal } from "./contracts.js";
import { ControlledClock } from "./clock.js";
import { FAMILY_CONTACTS, FAMILY_TIME_ZONE } from "./family-policy.js";
import {
  FallRescueService,
  type IngestResult,
} from "./orchestrator.js";
import { ScriptedNotificationProvider } from "./provider.js";
import {
  canWearerCancel,
  isInQuietHours,
  sortContactRules,
} from "./policy.js";
import { JsonRescueStore, MemoryRescueStore } from "./state.js";
import { RescueQueryService, type RescueSummary } from "./query.js";

interface ScenarioFixture {
  name: string;
  eventId: string;
  worn: boolean;
  receivedDelaySeconds?: number;
  stillSeconds?: number;
  capturedAt?: string;
  receivedAt?: string;
  responses?: unknown[];
}
const scenariosDoc = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "fall-scenarios.json"), "utf8"),
) as { wearerId: string; scenarios: ScenarioFixture[] };

const wearerId = scenariosDoc.wearerId;
const storePath = join(tmpdir(), "fall-rescue-demo.json");
rmSync(storePath, { force: true });

const clock = new ControlledClock();
const store = new JsonRescueStore(storePath);
const provider = new ScriptedNotificationProvider();
const makeService = (): FallRescueService =>
  new FallRescueService(store, provider, FAMILY_CONTACTS, clock, {
    timeZone: FAMILY_TIME_ZONE,
  });
let service = makeService();
const query = new RescueQueryService(() => store.load());

const hhmmss = (iso: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: FAMILY_TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));

function line(ch: string, title: string): void {
  console.log(`\n${"═".repeat(72)}\n${ch} ${title}\n${"─".repeat(72)}`);
}

function printTimeline(s: RescueSummary | null): void {
  if (!s) throw new Error("查询不到救援记录");
  console.log(
    `事件 ${s.eventId}｜状态 ${s.state}｜当前响应人 ${s.currentResponderId ?? "-"}` +
      `｜重复送达 ${s.deliveryCount} 次${s.escalationReason ? `｜升级原因：${s.escalationReason}` : ""}`,
  );
  for (const e of s.timeline) {
    console.log(`  ${hhmmss(e.occurredAt)}  [${e.state}] ${e.actorId}: ${e.reason}`);
  }
}

function tick(
  start: Date,
  elapsedSeconds: number,
  stepMs: number,
  hook?: (elapsed: number, svc: FallRescueService) => void,
): void {
  for (let ms = 0; ms <= elapsedSeconds * 1000; ms += stepMs) {
    clock.set(new Date(start.getTime() + ms));
    service.pump();
    hook?.(ms / 1000, service);
  }
}

function fixtureSignal(
  eventId: string,
  overrides: Partial<FallSignal> & Pick<FallSignal, "capturedAt" | "receivedAt">,
): FallSignal {
  return {
    eventId,
    wearerId,
    impactG: 1.4,
    postureChanged: false,
    stillSeconds: 0,
    worn: true,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 场景一：误触取消（设备落在沙发上）。20:00 触发，佩戴者 15 秒内取消。
// ════════════════════════════════════════════════════════════════════════
line("①", "误触取消：腕表落在沙发上，女儿不应被无谓惊扰");
const t1 = new Date("2026-09-15T20:00:00+08:00");
clock.set(new Date(t1.getTime() + 2000));
const signal1 = fixtureSignal("fall-1", {
  capturedAt: "2026-09-15T20:00:00+08:00",
  receivedAt: "2026-09-15T20:00:02+08:00",
  worn: false,
});
const first1: IngestResult = service.ingest(signal1);
console.log(`首次接入：duplicate=${String(first1.duplicate)}，进入 ${first1.rescue.state}`);

// 提供商重试把同一 eventId 又送来一次：必须去重，时间线零增长。
const before1 = first1.rescue.timeline.length;
const dup1 = service.ingest(signal1);
assert.equal(dup1.duplicate, true);
assert.equal(dup1.receipt.deliveryCount, 2);
assert.equal(dup1.rescue.timeline.length, before1);

// 佩戴者 15 秒后发现是设备误触，主动取消（无高风险特征、在时限内）。
clock.set(new Date(t1.getTime() + 15_000));
const cancel1 = service.wearerRespond("fall-1", { cancel: true });
console.log(`佩戴者取消结果：accepted=${String(cancel1.accepted)}，reason=${cancel1.reason}`);
printTimeline(query.summarize("fall-1"));

// ════════════════════════════════════════════════════════════════════════
// 场景二：真正摔倒，无人响应。强冲击 + 姿态变化 + 静止 90s（高风险）。
// 提供商首次语音失败后重试；期间两次“进程重启”，从磁盘恢复调度。
// ════════════════════════════════════════════════════════════════════════
line("②", "无人响应：高风险真实跌倒，重试与重启都不能阻断最终升级急救");
const t2 = new Date("2026-09-15T21:00:00+08:00");
clock.set(t2);
// 女儿的语音首次投递临时失败一次；急救渠道前 3 次失败（验证急救不受重试上限限制）。
provider.failFirst("daughter", "voice", 1);
provider.failFirst("emergency-services", "voice", 3);

const signal2 = fixtureSignal("fall-2", {
  capturedAt: "2026-09-15T21:00:00+08:00",
  receivedAt: "2026-09-15T21:00:00+08:00",
  worn: true,
  impactG: 3.4,
  postureChanged: true,
  stillSeconds: 90,
  locationToken: "loc-fall-2",
});
service.ingest(signal2);

let nextWakeBeforeRestart: Date | undefined;
tick(t2, 480, 5000, (elapsed) => {
  if (elapsed === 10) {
    // 佩戴者倒地后试图按“误触”取消：高风险特征下普通取消无效。
    const r = service.wearerRespond("fall-2", { cancel: true });
    console.log(`t+10s 高风险取消被拒：${r.reason}`);
  }
  if (elapsed === 40) {
    // 第一次“重启”：丢弃内存对象，仅靠磁盘上的 nextActionAt 继续。
    nextWakeBeforeRestart = service.nextWakeupAt() ?? undefined;
    service = makeService();
    console.log(
      `t+40s 服务重启，磁盘上下一动作时刻 ${nextWakeBeforeRestart ? hhmmss(nextWakeBeforeRestart.toISOString()) : "-"}`,
    );
  }
  if (elapsed === 110) {
    // 当前响应人是女儿（app 渠道）：她可读位置；邻居尚未接手，被拒绝。
    const ok = service.requestLocation("fall-2", "daughter");
    const no = service.requestLocation("fall-2", "neighbor");
    console.log(`t+110s 位置读取：daughter=${ok.reason}，neighbor=${no.reason}`);
  }
  if (elapsed === 245) {
    // 已顺位到儿子：女儿的短时授权在交接时即被收回。
    const stale = service.requestLocation("fall-2", "daughter");
    console.log(`t+245s 交接后女儿再读位置：${stale.reason}`);
  }
  if (elapsed === 300) {
    // 第二次重启：无内存定时器，pump 照样把链路走到急救。
    service = makeService();
    console.log("t+300s 服务再次重启");
  }
});
const s2 = query.summarize("fall-2");
printTimeline(s2);

// ════════════════════════════════════════════════════════════════════════
// 场景三：离线补传。09:10 摔倒，腕表离线，12:40 才补传。
// 询问窗口早已错过，直接联系人确认；女儿确认救援。13:00 又来一份重复消息。
// ════════════════════════════════════════════════════════════════════════
line("③", "离线补传：3.5 小时后告警才送达，跳过询问直接联系人确认");
const t3 = new Date("2026-09-15T12:40:00+08:00");
clock.set(t3);
service = makeService();
const sc3 = scenariosDoc.scenarios.find((x) => x.eventId === "fall-3") as {
  eventId: string;
  worn: boolean;
  capturedAt: string;
  receivedAt: string;
};
const signal3 = fixtureSignal("fall-3", {
  capturedAt: sc3.capturedAt,
  receivedAt: sc3.receivedAt,
  worn: sc3.worn,
});
service.ingest(signal3);
clock.set(new Date(t3.getTime() + 30_000));
const r3 = service.contactRespond("fall-3", {
  seq: 1,
  contactId: "daughter",
  confirm: true,
});
console.log(`女儿确认：${r3.reason}`);
const len3before = query.summarize("fall-3")!.timeline.length;
// 旧事件晚到的重复送达：只计数，不改时间线。
clock.set(new Date("2026-09-15T13:00:00+08:00"));
const dup3 = service.ingest(signal3);
assert.equal(dup3.duplicate, true);
printTimeline(query.summarize("fall-3"));

// ════════════════════════════════════════════════════════════════════════
// 家属查询：旧事件晚到后查询三个样例——唯一、顺序稳定、升级原因、当前响应人。
// ════════════════════════════════════════════════════════════════════════
line("④", "家属查询视图（重启一个全新查询实例读取同一存储）");
const requery = new RescueQueryService(() => store.load());
const all = requery.list();
for (const s of all) printTimeline(s);

// ── 断言 ────────────────────────────────────────────────────────────────
line("✓", "不变量断言");

// 场景一
const v1 = requery.summarize("fall-1")!;
assert.equal(v1.state, "resolved");
assert.equal(v1.resolution, "wearer-cancelled");
assert.equal(v1.deliveryCount, 2);
assert.equal(v1.currentResponderId, wearerId);
const sends1 = provider.sends.filter((x) => x.rescueId === "rescue-fall-1");
assert.equal(sends1.length, 0, "误触取消不应惊扰任何联系人");
console.log("  · fall-1：时限内取消，0 个联系人被呼叫，重复消息已去重");

// 场景二
const v2 = requery.summarize("fall-2")!;
assert.equal(v2.state, "resolved");
assert.equal(v2.resolution, "emergency-dispatched");
assert.equal(v2.currentResponderId, "emergency-services");
assert.ok(v2.escalationReason?.includes("确认超时"));
assert.deepEqual(
  v2.attempts.map((a) => `${a.contactId}:${a.channel}`),
  [
    "daughter:voice",
    "daughter:app",
    "daughter:sms",
    "son:voice",
    "son:sms",
    "neighbor:voice",
    "emergency-services:voice",
  ],
);
const emergencyAttempt = v2.attempts.find((a) => a.contactId === "emergency-services")!;
assert.equal(emergencyAttempt.providerTries, 4, "急救前 3 次提供商失败，第 4 次成功，救援未被阻断");
assert.equal(v2.highRisk, true);
assert.ok(v2.timeline.some((e) => e.reason.includes("高风险特征")));
console.log("  · fall-2：7 次尝试共用一条链；高风险取消被拒；急救重试 4 次后派遣");

// 位置留痕
const rec2 = store.load().rescues["rescue-fall-2"]!;
const audit = rec2.location!.audit;
assert.ok(audit.some((a) => a.contactId === "neighbor" && !a.allowed));
assert.ok(audit.some((a) => a.contactId === "daughter" && a.action === "revoke"));
assert.ok(audit.every((a) => typeof a.reason === "string" && a.reason.length > 0));
assert.ok(!rec2.location!.grants.some((g) => g.contactId === "daughter" && g.active));
assert.equal(rec2.location!.grants.filter((g) => g.contactId === "daughter").length, 3, "每次呼叫都重新短时授权");
console.log("  · 位置：仅当前响应者可读，交接即收回，允许/拒绝/收回全部留痕");

// 场景三
const v3 = requery.summarize("fall-3")!;
assert.equal(v3.state, "resolved");
assert.equal(v3.resolution, "confirmed-by-contact");
assert.equal(v3.offline, true);
assert.equal(v3.deliveryCount, 2);
assert.equal(v3.timeline.length, len3before, "晚到重复消息不改变时间线");
assert.ok(v3.timeline.some((e) => e.reason.includes("离线补传")));
assert.equal(v3.escalationReason, null);
assert.equal(v3.currentResponderId, "daughter");
console.log("  · fall-3：离线补传跳过询问，女儿确认；晚到重复只计数");

// 唯一性与顺序稳定
assert.deepEqual(all.map((s) => s.eventId), ["fall-1", "fall-2", "fall-3"]);
for (const s of all) {
  const ids = s.timeline.map((e) => e.entryId);
  assert.equal(new Set(ids).size, ids.length, "时间线条目唯一");
  assert.deepEqual(ids, [...ids].sort(), "entryId 单调、顺序稳定");
  const times = s.timeline.map((e) => e.occurredAt);
  assert.deepEqual(times, [...times].sort(), "时间戳非递减");
}
console.log("  · 三个样例各对应唯一救援，时间线唯一且顺序稳定");

// 重启恢复：第一次重启前记下的唤醒时刻来自持久化，重启后无内存定时器仍走完全链
const wakeRef = nextWakeBeforeRestart;
if (wakeRef === undefined) {
  throw new Error("重启钩子应当已记录下一动作时刻");
}
console.log(
  `  · 重启前持久化的下一动作时刻：${hhmmss(wakeRef.toISOString())}`,
);
assert.equal(requery.summarize("fall-2")!.resolution, "emergency-dispatched");
console.log("  · 两次重启后仅凭存储中的 nextActionAt 继续安排下一次动作");

// 静默时段端到端：凌晨 02:00 女儿、儿子都在静默时段，直接顺位邻居，急救不受限
const nightStore = new MemoryRescueStore();
const nightClock = new ControlledClock(new Date("2026-09-16T02:00:00+08:00"));
const nightService = new FallRescueService(
  nightStore,
  new ScriptedNotificationProvider(),
  FAMILY_CONTACTS,
  nightClock,
  { timeZone: FAMILY_TIME_ZONE },
);
nightService.ingest(
  fixtureSignal("fall-night", {
    capturedAt: "2026-09-16T02:00:00+08:00",
    receivedAt: "2026-09-16T02:00:00+08:00",
    worn: true,
    impactG: 1.2,
  }),
);
nightClock.advanceSeconds(35);
nightService.pump();
const nightQuery = new RescueQueryService(() => nightStore.load());
const night = nightQuery.summarize("fall-night")!;
assert.equal(night.attempts[0]!.contactId, "neighbor", "静默时段应首先呼叫邻居");
assert.equal(
  night.timeline.filter((e) => e.reason.includes("静默时段")).length,
  2,
  "女儿与儿子的静默跳过都应在时间线留痕",
);
assert.deepEqual(
  nightService
    .contactRespond("fall-night", { seq: 1, contactId: "neighbor", confirm: true }),
  { accepted: true, reason: "confirmed" },
);
console.log("  · 凌晨静默时段：女儿/儿子被跳过并留痕，邻居首先被呼叫并确认");

// 策略自检
const [daughter] = sortContactRules(FAMILY_CONTACTS as ContactRule[]);
assert.equal(daughter!.contactId, "daughter");
assert.equal(isInQuietHours(daughter!, new Date("2026-09-15T01:00:00+08:00"), FAMILY_TIME_ZONE), true);
assert.equal(isInQuietHours(daughter!, new Date("2026-09-15T12:00:00+08:00"), FAMILY_TIME_ZONE), false);
assert.equal(canWearerCancel({ highRisk: true, askStartedAt: 0, at: 1000 }), false);
assert.equal(canWearerCancel({ highRisk: false, askStartedAt: 0, at: 61_000 }), false);
assert.equal(canWearerCancel({ highRisk: false, askStartedAt: 0, at: 5000 }), true);
console.log("  · 跨午夜静默时段、高风险不可取消、取消时限规则均符合策略");

console.log(`\n全部断言通过。持久化文件：${storePath}`);
