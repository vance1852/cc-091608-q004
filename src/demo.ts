import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REASON_LABELS } from "./contracts.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import { JsonFileStore } from "./store.ts";
import { replayFixtures } from "./replay.ts";

/**
 * 端到端演示：用文件持久化回放 fixtures 的三段经过，
 * 每个"会话"都重新实例化编排器（等价服务重启），最后打印家属查询视图。
 */
const statePath = join(tmpdir(), "fall-rescue-state.json");
await rm(statePath, { force: true });

const { views, accessLog } = await replayFixtures(new JsonFileStore(statePath));

const STATE_LABELS: Record<string, string> = {
  "asking-wearer": "询问佩戴者",
  contacting: "联系家属中",
  emergency: "急救处置中",
  resolved: "已结束",
};

/** 统一以家属所在时区（北京）展示，避免 Z 与 +08:00 混用造成误读。 */
function fmt(iso: string): string {
  const wall = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return `${wall.replace(" ", "T")}+08:00`;
}

for (const view of views) {
  const e = view.event;
  console.log("=".repeat(72));
  console.log(`事件 ${e.eventId}（救援链 ${e.rescueId}）`);
  console.log(
    `状态：${STATE_LABELS[view.state]}　风险：${e.risk}${e.highRiskFeatures.length ? `（${e.highRiskFeatures.join("、")}）` : ""}　当前响应人：${view.currentResponderId ?? "—"}`,
  );
  console.log(
    `采集 ${fmt(e.signal.capturedAt)} → 收到 ${fmt(e.firstReceivedAt)}，重复包 ${e.duplicateCount} 个`,
  );
  if (e.resolution) console.log(`结束方式：${e.resolution} @ ${fmt(e.resolvedAt!)}`);
  console.log("- 时间线（唯一且按发生时间稳定排序）-");
  for (const t of view.timeline) {
    console.log(`  [${fmt(t.occurredAt)}] (${t.state}) ${t.actorId}: ${t.reason}`);
  }
  console.log("- 升级原因 -");
  for (const x of view.escalations) {
    console.log(`  [${fmt(x.at)}] ${x.fromState} → ${x.reason}${x.detail ? `（${x.detail}）` : ""}`);
  }
}

console.log("=".repeat(72));
console.log("位置读取留痕（每次读取均记录，含拒绝）：");
for (const r of accessLog) {
  console.log(`  [${fmt(r.at)}] ${r.readerId} ${r.allowed ? "允许" : `拒绝:${r.reason}`}`);
}
console.log("-".repeat(72));
console.log(`策略：询问 ${DEFAULT_POLICY.askTimeoutSeconds}s / 取消时限 ${DEFAULT_POLICY.cancelWindowSeconds}s / 联系人窗口 ${DEFAULT_POLICY.contactTimeoutSeconds}s`);
console.log(`状态文件：${statePath}`);
