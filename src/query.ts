import type { RescueStateRecord } from "./state.js";

export interface RescueSummary {
  eventId: string;
  rescueId: string;
  wearerId: string;
  state: RescueStateRecord["state"];
  resolution?: RescueStateRecord["resolution"] | undefined;
  currentResponderId?: string | undefined;
  deliveryCount: number;
  highRisk: boolean;
  offline: boolean;
  /** 升级（进入急救）的原因，未升级时为 null。 */
  escalationReason: string | null;
  nextActionAt: string | null;
  timeline: ReadonlyArray<{
    entryId: string;
    state: RescueStateRecord["state"];
    actorId: string;
    reason: string;
    occurredAt: string;
  }>;
  attempts: ReadonlyArray<{
    seq: number;
    contactId: string;
    channel: string;
    status: string;
    providerTries: number;
  }>;
}

export interface FamilyQueryService {
  /** 按事件标识查询唯一救援视图；时间线顺序稳定（追加式、entryId 单调）。 */
  summarize(eventId: string): RescueSummary | null;
  list(): RescueSummary[];
}

const ESCALATION_PREFIX = "升级急救：";

export class RescueQueryService implements FamilyQueryService {
  constructor(private readonly load: () => { rescues: Record<string, RescueStateRecord>; signals: Record<string, { rescueId: string; deliveryCount: number }> }) {}

  summarize(eventId: string): RescueSummary | null {
    const data = this.load();
    const receipt = data.signals[eventId];
    if (!receipt) return null;
    const record = data.rescues[receipt.rescueId];
    if (!record) return null;
    return this.toSummary(record, receipt.deliveryCount);
  }

  list(): RescueSummary[] {
    const data = this.load();
    return Object.values(data.signals)
      .map((receipt) => {
        const record = data.rescues[receipt.rescueId];
        return record ? this.toSummary(record, receipt.deliveryCount) : null;
      })
      .filter((s): s is RescueSummary => s !== null)
      .sort((a, b) => a.eventId.localeCompare(b.eventId));
  }

  private toSummary(
    record: RescueStateRecord,
    deliveryCount: number,
  ): RescueSummary {
    const escalation =
      record.timeline.find((e) => e.reason.startsWith(ESCALATION_PREFIX))
        ?.reason ?? null;
    return {
      eventId: record.eventId,
      rescueId: record.rescueId,
      wearerId: record.wearerId,
      state: record.state,
      resolution: record.resolution,
      currentResponderId: record.currentResponderId,
      deliveryCount,
      highRisk: record.risk.highRisk,
      offline: record.risk.features.offline,
      escalationReason: escalation
        ? (escalation.slice(ESCALATION_PREFIX.length).split("，")[0] ?? null)
        : null,
      nextActionAt: record.nextActionAt
        ? new Date(record.nextActionAt).toISOString()
        : null,
      // 直接回传存储中的追加序列；entryId 单调，顺序不随重放或晚到事件改变。
      timeline: record.timeline.map((e) => ({
        entryId: e.entryId,
        state: e.state,
        actorId: e.actorId,
        reason: e.reason,
        occurredAt: e.occurredAt,
      })),
      attempts: record.attempts.map((a) => ({
        seq: a.seq,
        contactId: a.contactId,
        channel: a.channel,
        status: a.status,
        providerTries: a.providerTries,
      })),
    };
  }
}
