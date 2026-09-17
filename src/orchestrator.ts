import type { ContactRule, RescueState, RescueTimelineEntry } from "./contracts.js";
import type { Clock } from "./clock.js";
import {
  ASK_WEARER_TIMEOUT_MS,
  CONTACT_ATTEMPT_TIMEOUT_MS,
  LOCATION_TTL_MS,
  MAX_CHANNELS_PER_CONTACT,
  MAX_PROVIDER_RETRIES,
  PROVIDER_RETRY_DELAY_MS,
  assessSignal,
  canWearerCancel,
  isInQuietHours,
  sortContactRules,
} from "./policy.js";
import {
  EMERGENCY_CONTACT_ID,
  type DeliveryResult,
  type NotificationPort,
} from "./provider.js";
import {
  type Attempt,
  type Channel,
  type LocationAuditEntry,
  type PendingAction,
  type PlanEntry,
  type RescueStateRecord,
  type RescueStore,
  type SignalReceipt,
  type StoreData,
} from "./state.js";

export interface WearerResponse {
  cancel: boolean;
}

export type CallReceiptStatus = "answered" | "no-answer" | "busy" | "failed";

export interface CallReceipt {
  seq: number;
  status: CallReceiptStatus;
  at?: Date;
}

export interface ContactResponse {
  seq: number;
  contactId: string;
  /** true = 按键/点击确认正在救援；false = 明确拒绝。 */
  confirm: boolean;
  at?: Date;
}

export interface IngestResult {
  rescue: RescueStateRecord;
  receipt: SignalReceipt;
  /** true 表示该事件标识曾送达过，本次为重复投递（已去重，时间线不新增）。 */
  duplicate: boolean;
}

const pad = (value: number): string => String(value).padStart(4, "0");

/**
 * 跌倒事件与救援编排服务。
 *
 * 不变量：
 *  - 同一 eventId 的重复送达只计数，绝不产生第二条救援链或重复时间线；
 *  - 每次状态推进都持久化 pendingAction/nextActionAt，重启后从存储继续；
 *  - 呼叫回执、无人应答超时、提供商重试全部落在同一条 attempt 链上；
 *  - 位置令牌只对当前响应者短时有效，每次读取（允许或拒绝）都留痕。
 */
export interface FallRescueOptions {
  /** 家属所在地时区，静默时段按此时区解释。 */
  timeZone?: string;
  /** 位置授权时长，缺省取策略常量。 */
  locationTtlMs?: number;
}

export class FallRescueService {
  private readonly timeZone: string | undefined;
  private readonly locationTtlMs: number;

  constructor(
    private readonly store: RescueStore,
    private readonly provider: NotificationPort,
    private readonly rules: readonly ContactRule[],
    private readonly clock: Clock,
    options: FallRescueOptions = {},
  ) {
    this.timeZone = options.timeZone;
    this.locationTtlMs = options.locationTtlMs ?? LOCATION_TTL_MS;
  }

  // ---- 接入与去重 -------------------------------------------------------

  ingest(signal: RescueStateRecord["signal"]): IngestResult {
    const data = this.store.load();
    const known = data.signals[signal.eventId];
    if (known) {
      known.deliveryCount += 1;
      this.store.save(data);
      const rescue = data.rescues[known.rescueId];
      if (!rescue) throw new Error(`救援记录缺失: ${known.rescueId}`);
      return { rescue, receipt: { ...known }, duplicate: true };
    }

    const now = this.clock.now();
    const risk = assessSignal(signal, now);
    const rescueId = `rescue-${signal.eventId}`;
    const record: RescueStateRecord = {
      schema: 1,
      rescueId,
      eventId: signal.eventId,
      wearerId: signal.wearerId,
      signal,
      risk,
      state: "asking-wearer",
      plan: [],
      attempts: [],
      emergencyDispatched: false,
      timeline: [],
      counter: 0,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
    if (signal.locationToken) {
      record.location = { token: signal.locationToken, grants: [], audit: [] };
    }

    const featureText = [
      risk.features.strongImpact ? `强冲击${signal.impactG}g` : null,
      risk.features.postureChanged ? "姿态变化" : null,
      risk.features.prolongedStillness ? `静止${signal.stillSeconds}s` : null,
      risk.features.notWorn ? "未佩戴" : null,
      risk.features.offline
        ? `离线补传延迟${Math.round(risk.offlineDelayMs / 1000)}s`
        : null,
    ]
      .filter(Boolean)
      .join("、") || "无显著特征";
    this.appendEntry(
      record,
      "system",
      "asking-wearer",
      `收到跌倒候选（${featureText}）`,
      now,
    );

    if (risk.credibility === "stale") {
      // 离线数小时后补传：询问窗口早已错过，跳过佩戴者询问，直接联系人确认。
      record.askStartedAt = now.getTime();
      this.appendEntry(
        record,
        "system",
        "contacting",
        "事件为离线补传且已陈旧，跳过佩戴者询问，直接进入联系人确认",
        now,
      );
      record.state = "contacting";
      this.startContacting(record, now);
    } else {
      record.state = "asking-wearer";
      record.askStartedAt = now.getTime();
      record.currentResponderId = signal.wearerId;
      this.appendEntry(
        record,
        signal.wearerId,
        "asking-wearer",
        risk.features.notWorn
          ? "设备疑似未佩戴，向佩戴者发出误触确认询问"
          : "向佩戴者发出求助确认询问",
        now,
      );
      this.schedule(record, {
        kind: "ask-timeout",
        dueAt: now.getTime() + ASK_WEARER_TIMEOUT_MS,
      });
    }

    data.signals[signal.eventId] = {
      eventId: signal.eventId,
      rescueId,
      firstReceivedAt: signal.receivedAt,
      deliveryCount: 1,
    };
    data.rescues[rescueId] = record;
    this.persist(data, record);
    return {
      rescue: record,
      receipt: { ...data.signals[signal.eventId]! },
      duplicate: false,
    };
  }

  // ---- 佩戴者取消 -------------------------------------------------------

  /**
   * 佩戴者普通取消：仅在策略时限内、且告警不带高风险特征时有效。
   * 高风险告警或超时后的取消不能关闭事件，会继续联系人确认。
   */
  wearerRespond(eventId: string, response: WearerResponse): {
    accepted: boolean;
    reason: string;
    rescue: RescueStateRecord;
  } {
    const data = this.store.load();
    const record = this.requireRescueByEvent(data, eventId);
    const at = this.clock.now();

    if (record.state === "resolved") {
      return { accepted: false, reason: "already-resolved", rescue: record };
    }

    if (!response.cancel) {
      if (record.state !== "asking-wearer") {
        return { accepted: false, reason: "not-asking", rescue: record };
      }
      this.appendEntry(
        record,
        record.wearerId,
        "contacting",
        "佩戴者确认需要帮助，立即进入联系人确认",
        at,
      );
      this.transitionToContacting(record, at);
      this.persist(data, record);
      return { accepted: true, reason: "wearer-confirmed", rescue: record };
    }

    if (record.state !== "asking-wearer") {
      this.appendEntry(
        record,
        record.wearerId,
        record.state,
        "佩戴者取消请求被拒绝：询问窗口已结束，救援链继续",
        at,
      );
      this.persist(data, record);
      return { accepted: false, reason: "window-closed", rescue: record };
    }

    const allowed = canWearerCancel({
      highRisk: record.risk.highRisk,
      askStartedAt: record.askStartedAt ?? at.getTime(),
      at: at.getTime(),
    });
    if (!allowed) {
      const why = record.risk.highRisk
        ? "告警带高风险特征，普通取消不能关闭"
        : "已超过策略取消时限";
      this.appendEntry(
        record,
        record.wearerId,
        "asking-wearer",
        `佩戴者取消请求被拒绝：${why}，继续等待联系人确认`,
        at,
      );
      this.persist(data, record);
      return { accepted: false, reason: "policy-rejected", rescue: record };
    }

    this.resolve(record, "wearer-cancelled", record.wearerId, at);
    this.persist(data, record);
    return { accepted: true, reason: "cancelled", rescue: record };
  }

  // ---- 呼叫回执 / 联系人响应 -------------------------------------------

  /** 提供商异步呼叫回执（接听、无人接、占线、通道失败）汇入当前尝试。 */
  recordCallReceipt(eventId: string, receipt: CallReceipt): void {
    const data = this.store.load();
    const record = this.requireRescueByEvent(data, eventId);
    const at = receipt.at ?? this.clock.now();
    if (record.state === "resolved") return;
    const attempt = record.attempts.find((a) => a.seq === receipt.seq);
    if (!attempt || attempt.status !== "awaiting-confirmation") return;

    if (receipt.status === "answered") {
      attempt.reason = "answered-awaiting-keypress";
      this.appendEntry(
        record,
        attempt.contactId,
        record.state,
        `#${attempt.seq} ${attempt.channel} 已接听，等待按键确认`,
        at,
      );
    } else if (receipt.status === "failed") {
      this.appendEntry(
        record,
        "provider",
        record.state,
        `#${attempt.seq} ${attempt.channel} 收到提供商失败回执，按重试处理`,
        at,
      );
      this.redeliverOrAdvance(record, attempt, at, receipt.status);
    } else {
      const text = receipt.status === "no-answer" ? "无人接听" : "占线";
      this.appendEntry(
        record,
        attempt.contactId,
        record.state,
        `#${attempt.seq} ${attempt.channel} ${text}，顺位通知下一响应者`,
        at,
      );
      this.closeAttemptAndAdvance(record, attempt, "expired", text, at);
    }
    this.persist(data, record);
  }

  /** 联系人按键确认 / 明确拒绝。非当前响应者的响应被忽略。 */
  contactRespond(eventId: string, response: ContactResponse): {
    accepted: boolean;
    reason: string;
  } {
    const data = this.store.load();
    const record = this.requireRescueByEvent(data, eventId);
    const at = response.at ?? this.clock.now();
    if (record.state === "resolved") {
      return { accepted: false, reason: "already-resolved" };
    }
    const attempt = record.attempts.find((a) => a.seq === response.seq);
    if (
      !attempt ||
      attempt.status !== "awaiting-confirmation" ||
      attempt.contactId !== response.contactId ||
      record.currentResponderId !== response.contactId
    ) {
      return { accepted: false, reason: "not-current-responder" };
    }

    if (response.confirm) {
      attempt.status = "confirmed";
      attempt.finishedAt = at.getTime();
      this.appendEntry(
        record,
        response.contactId,
        record.state,
        `#${attempt.seq} ${response.contactId} 确认正在前往救援`,
        at,
      );
      this.resolve(record, "confirmed-by-contact", response.contactId, at);
    } else {
      this.appendEntry(
        record,
        response.contactId,
        record.state,
        `#${attempt.seq} ${response.contactId} 表示无法响应，顺位下一响应者`,
        at,
      );
      this.closeAttemptAndAdvance(record, attempt, "declined", "联系人拒绝", at);
    }
    this.persist(data, record);
    return {
      accepted: true,
      reason: response.confirm ? "confirmed" : "declined",
    };
  }

  // ---- 位置：仅当前响应者、短时开放、每次读取留痕 -----------------------

  requestLocation(eventId: string, contactId: string): {
    allowed: boolean;
    token?: string;
    expiresAt?: Date;
    reason: string;
  } {
    const data = this.store.load();
    const record = this.requireRescueByEvent(data, eventId);
    const at = this.clock.now();
    const result = this.checkLocation(record, contactId, at);
    this.persist(data, record);
    return result;
  }

  private checkLocation(
    record: RescueStateRecord,
    contactId: string,
    at: Date,
  ): { allowed: boolean; token?: string; expiresAt?: Date; reason: string } {
    if (!record.location) {
      this.auditLocation(record, "read", contactId, at, false, "事件不含位置令牌");
      return { allowed: false, reason: "no-location" };
    }
    const grant = [...record.location.grants]
      .reverse()
      .find((g) => g.contactId === contactId);
    if (!grant || !grant.active) {
      this.auditLocation(
        record,
        "read",
        contactId,
        at,
        false,
        "非当前响应者，位置未开放",
      );
      return { allowed: false, reason: "not-current-responder" };
    }
    if (grant.expiresAt <= at.getTime()) {
      grant.active = false;
      grant.revokeReason = "ttl-expired";
      this.auditLocation(
        record,
        "read",
        contactId,
        at,
        false,
        "位置授权已超时收回",
      );
      return { allowed: false, reason: "grant-expired" };
    }
    this.auditLocation(
      record,
      "read",
      contactId,
      at,
      true,
      "当前响应者短时读取位置",
    );
    return {
      allowed: true,
      token: record.location.token,
      expiresAt: new Date(grant.expiresAt),
      reason: "ok",
    };
  }

  // ---- 重启恢复 ---------------------------------------------------------

  /**
   * 处理所有到期动作。进程重启后调用一次即可：服务不依赖内存定时器，
   * 下一动作始终可从记录中的 nextActionAt 重建。
   */
  pump(at: Date = this.clock.now()): Array<{ eventId: string }> {
    const data = this.store.load();
    const advanced: Array<{ eventId: string }> = [];
    for (const record of Object.values(data.rescues)) {
      if (record.state === "resolved") continue;
      const before = record.timeline.length;
      this.pumpRecord(record, at);
      this.expireLocationGrants(record, at);
      if (record.timeline.length !== before) {
        advanced.push({ eventId: record.eventId });
      }
    }
    this.store.save(data);
    return advanced;
  }

  /** 返回下一次需要唤醒的时刻，重启后用它重建调度。 */
  nextWakeupAt(): Date | null {
    const data = this.store.load();
    const dues = Object.values(data.rescues)
      .filter((r) => r.state !== "resolved")
      .map((r) => r.nextActionAt)
      .filter((v): v is number => typeof v === "number");
    return dues.length ? new Date(Math.min(...dues)) : null;
  }

  getByEventId(eventId: string): RescueStateRecord | null {
    const data = this.store.load();
    const receipt = data.signals[eventId];
    return receipt ? (data.rescues[receipt.rescueId] ?? null) : null;
  }

  // ---- 内部：状态推进 ---------------------------------------------------

  private pumpRecord(record: RescueStateRecord, at: Date): void {
    // 同一条链上的动作可能连环到期（重试、超时、升级），循环处理。
    for (;;) {
      this.expireLocationGrants(record, at);
      const action = record.pendingAction;
      if (!action || action.dueAt > at.getTime()) break;
      record.pendingAction = undefined;
      record.nextActionAt = undefined;
      if (action.kind === "ask-timeout") {
        if (record.state !== "asking-wearer") continue;
        this.appendEntry(
          record,
          "system",
          "contacting",
          "佩戴者在询问时限内未取消，进入联系人确认",
          at,
        );
        this.transitionToContacting(record, at);
      } else if (action.kind === "provider-retry") {
        const attempt = record.attempts.find((a) => a.seq === action.seq);
        if (attempt && attempt.status === "pending") {
          this.deliver(record, attempt, at);
        }
      } else if (action.kind === "attempt-timeout") {
        const attempt = record.attempts.find((a) => a.seq === action.seq);
        if (attempt && attempt.status === "awaiting-confirmation") {
          this.appendEntry(
            record,
            "system",
            record.state,
            `#${attempt.seq} 等待 ${attempt.contactId} 确认超时，顺位下一响应者`,
            at,
          );
          this.closeAttemptAndAdvance(record, attempt, "expired", "确认超时", at);
        }
      }
    }
  }

  private transitionToContacting(record: RescueStateRecord, at: Date): void {
    if (record.state === "contacting") return;
    record.state = "contacting";
    record.currentResponderId = undefined;
    this.startContacting(record, at);
  }

  private startContacting(record: RescueStateRecord, at: Date): void {
    const { entries, skipped } = this.buildPlan(at);
    // 计划在进入联系阶段时冻结，重启与后续策略变动都不改变这条链。
    record.plan = entries;
    for (const skip of skipped) {
      this.appendEntry(
        record,
        skip.contactId,
        "contacting",
        `${skip.contactId} 处于静默时段（${skip.from}-${skip.to}），跳过其非紧急渠道`,
        at,
      );
    }
    if (entries.length === 0) {
      this.escalateToEmergency(record, at, "所有联系人均不可用");
      return;
    }
    this.beginAttempt(record, at);
  }

  private buildPlan(at: Date): {
    entries: PlanEntry[];
    skipped: Array<{ contactId: string; from: string; to: string }>;
  } {
    const entries: PlanEntry[] = [];
    const skipped: Array<{ contactId: string; from: string; to: string }> = [];
    for (const rule of sortContactRules([...this.rules])) {
      if (rule.quietHours && isInQuietHours(rule, at, this.timeZone)) {
        skipped.push({
          contactId: rule.contactId,
          from: rule.quietHours.from,
          to: rule.quietHours.to,
        });
        continue;
      }
      for (const channel of rule.channels.slice(0, MAX_CHANNELS_PER_CONTACT)) {
        entries.push({ contactId: rule.contactId, channel });
      }
    }
    return { entries, skipped };
  }

  private beginAttempt(record: RescueStateRecord, at: Date): void {
    const seq = record.attempts.length + 1;
    const entry = record.plan[seq - 1];
    if (!entry) {
      this.escalateToEmergency(record, at, "全部联系人渠道均未确认");
      return;
    }
    const attempt: Attempt = {
      attemptId: `${record.rescueId}-att-${pad(seq)}`,
      seq,
      contactId: entry.contactId,
      channel: entry.channel,
      providerTries: 0,
      status: "pending",
      startedAt: at.getTime(),
    };
    record.attempts.push(attempt);
    record.currentResponderId = entry.contactId;
    this.appendEntry(
      record,
      entry.contactId,
      "contacting",
      `#${seq} 经 ${entry.channel} 呼叫 ${entry.contactId}`,
      at,
    );
    this.deliver(record, attempt, at);
  }

  private deliver(record: RescueStateRecord, attempt: Attempt, at: Date): void {
    const emergency = record.state === "emergency";
    attempt.providerTries += 1;
    const result: DeliveryResult = this.provider.send({
      rescueId: record.rescueId,
      seq: attempt.seq,
      contactId: attempt.contactId,
      channel: attempt.channel as Channel,
      emergency,
      wearerId: record.wearerId,
      text: emergency
        ? `急救请求：${record.wearerId} 触发跌倒告警且所有联系人未响应`
        : `跌倒告警：请确认 ${record.wearerId} 的状况，按键确认正在救援`,
      // 令牌随呼叫下发，但服务端仍按“当前响应者授权”校验每次读取。
      locationToken: record.location?.token,
    });

    if (result.accepted) {
      attempt.providerMessageId = result.providerMessageId;
      this.appendEntry(
        record,
        "provider",
        record.state,
        `#${attempt.seq} 提供商已受理（${result.providerMessageId ?? "?"}，第${attempt.providerTries}次投递）`,
        at,
      );
      if (emergency) {
        // 急救呼叫被受理即视为已派遣，救援链闭环。
        attempt.status = "dispatched";
        attempt.finishedAt = at.getTime();
        record.emergencyDispatched = true;
        this.resolve(record, "emergency-dispatched", EMERGENCY_CONTACT_ID, at);
        return;
      }
      attempt.status = "awaiting-confirmation";
      attempt.dueAt = at.getTime() + CONTACT_ATTEMPT_TIMEOUT_MS;
      attempt.reason = undefined;
      this.grantLocation(record, attempt.contactId, at);
      this.schedule(record, {
        kind: "attempt-timeout",
        seq: attempt.seq,
        dueAt: attempt.dueAt,
      });
    } else {
      this.appendEntry(
        record,
        "provider",
        record.state,
        `#${attempt.seq} 提供商临时失败（${result.reason ?? "unknown"}，第${attempt.providerTries}次投递）`,
        at,
      );
      this.redeliverOrAdvance(record, attempt, at, result.reason);
    }
  }

  private redeliverOrAdvance(
    record: RescueStateRecord,
    attempt: Attempt,
    at: Date,
    reason?: string,
  ): void {
    const emergency = record.state === "emergency";
    // 急救渠道即使超过常规重试上限也继续重试——救援不能因提供商故障被阻断。
    if (emergency || attempt.providerTries <= MAX_PROVIDER_RETRIES) {
      const dueAt = at.getTime() + PROVIDER_RETRY_DELAY_MS;
      attempt.status = "pending";
      attempt.dueAt = dueAt;
      this.appendEntry(
        record,
        "provider",
        record.state,
        `#${attempt.seq} 安排提供商重试，将于 ${PROVIDER_RETRY_DELAY_MS / 1000}s 后再次投递`,
        at,
      );
      this.schedule(record, {
        kind: "provider-retry",
        seq: attempt.seq,
        triesSoFar: attempt.providerTries,
        dueAt,
      });
    } else {
      this.closeAttemptAndAdvance(
        record,
        attempt,
        "failed",
        reason ?? "提供商重试耗尽",
        at,
      );
    }
  }

  private closeAttemptAndAdvance(
    record: RescueStateRecord,
    attempt: Attempt,
    status: Attempt["status"],
    reason: string,
    at: Date,
  ): void {
    attempt.status = status;
    attempt.reason = reason;
    attempt.finishedAt = at.getTime();
    this.revokeLocation(record, attempt.contactId, at, "响应者切换");
    if (record.state === "emergency") {
      // 急救呼叫的终端失败：回到待重试状态，继续尝试派遣。
      this.redeliverOrAdvance(record, attempt, at, reason);
      return;
    }
    if (attempt.seq >= record.plan.length) {
      this.escalateToEmergency(record, at, reason);
    } else {
      this.beginAttempt(record, at);
    }
  }

  private escalateToEmergency(
    record: RescueStateRecord,
    at: Date,
    reason: string,
  ): void {
    record.state = "emergency";
    this.appendEntry(
      record,
      EMERGENCY_CONTACT_ID,
      "emergency",
      `升级急救：${reason}，联系人未响应不阻断救援，改拨急救服务`,
      at,
    );
    const attempt: Attempt = {
      attemptId: `${record.rescueId}-att-${pad(record.attempts.length + 1)}`,
      seq: record.attempts.length + 1,
      contactId: EMERGENCY_CONTACT_ID,
      channel: "voice",
      providerTries: 0,
      status: "pending",
      startedAt: at.getTime(),
    };
    record.attempts.push(attempt);
    record.currentResponderId = EMERGENCY_CONTACT_ID;
    this.deliver(record, attempt, at);
  }

  // ---- 内部：位置授权 ---------------------------------------------------

  private grantLocation(
    record: RescueStateRecord,
    contactId: string,
    at: Date,
  ): void {
    if (!record.location) return;
    // 位置只对“当前”响应者开放：新响应者接手时，旧授权一律立即收回并留痕。
    for (const grant of record.location.grants) {
      if (!grant.active) continue;
      grant.active = false;
      grant.revokeReason =
        grant.contactId === contactId ? "re-granted" : "responder-handover";
      this.auditLocation(
        record,
        "revoke",
        grant.contactId,
        at,
        false,
        `收回位置：${grant.revokeReason}`,
      );
    }
    const grantedAt = at.getTime();
    record.location.grants.push({
      token: record.location.token,
      contactId,
      grantedAt,
      expiresAt: grantedAt + this.locationTtlMs,
      active: true,
    });
    this.auditLocation(record, "grant", contactId, at, true, "向当前响应者短时开放位置");
  }

  private revokeLocation(
    record: RescueStateRecord,
    contactId: string,
    at: Date,
    reason: string,
  ): void {
    if (!record.location) return;
    for (const grant of record.location.grants) {
      if (grant.active && grant.contactId === contactId) {
        grant.active = false;
        grant.revokeReason = reason;
        this.auditLocation(record, "revoke", contactId, at, false, `收回位置：${reason}`);
      }
    }
  }

  private expireLocationGrants(record: RescueStateRecord, at: Date): void {
    if (!record.location) return;
    for (const grant of record.location.grants) {
      if (grant.active && grant.expiresAt <= at.getTime()) {
        grant.active = false;
        grant.revokeReason = "ttl-expired";
        this.auditLocation(
          record,
          "revoke",
          grant.contactId,
          at,
          false,
          "收回位置：授权到期自动收回",
        );
      }
    }
  }

  private auditLocation(
    record: RescueStateRecord,
    action: LocationAuditEntry["action"],
    contactId: string,
    at: Date,
    allowed: boolean,
    reason: string,
  ): void {
    if (!record.location) return;
    record.location.audit.push({
      auditId: `${record.rescueId}-loc-${pad(record.location.audit.length + 1)}`,
      action,
      token: record.location.token,
      contactId,
      at: at.getTime(),
      allowed,
      reason,
    });
  }

  // ---- 内部：持久化辅助 -------------------------------------------------

  /**
   * 先处理到期动作再落盘：即使提交时已有动作到期（例如重启补偿），
   * 同一次保存里也包含推进后的状态，保证“中途重启也继续安排下一次动作”。
   */
  private persist(data: StoreData, record: RescueStateRecord): void {
    this.pumpRecord(record, this.clock.now());
    record.updatedAt = this.clock.now().getTime();
    data.rescues[record.rescueId] = record;
    this.store.save(data);
  }

  private resolve(
    record: RescueStateRecord,
    resolution: NonNullable<RescueStateRecord["resolution"]>,
    actorId: string,
    at: Date,
  ): void {
    record.state = "resolved";
    record.resolution = resolution;
    record.pendingAction = undefined;
    record.nextActionAt = undefined;
    record.currentResponderId = actorId;
    const text =
      resolution === "wearer-cancelled"
        ? "佩戴者在策略时限内取消，事件结束（未惊扰联系人）"
        : resolution === "confirmed-by-contact"
          ? "联系人已确认救援，事件结束"
          : "急救已派遣，事件结束";
    this.appendEntry(record, actorId, "resolved", text, at);
  }

  private schedule(record: RescueStateRecord, action: PendingAction): void {
    record.pendingAction = action;
    record.nextActionAt = action.dueAt;
  }

  private appendEntry(
    record: RescueStateRecord,
    actorId: string,
    state: RescueState,
    reason: string,
    at: Date,
  ): RescueTimelineEntry {
    record.counter += 1;
    const entry: RescueTimelineEntry = {
      entryId: `${record.rescueId}-tl-${pad(record.counter)}`,
      rescueId: record.rescueId,
      state,
      actorId,
      reason,
      occurredAt: at.toISOString(),
    };
    record.timeline.push(entry);
    record.updatedAt = at.getTime();
    return entry;
  }

  private requireRescueByEvent(
    data: StoreData,
    eventId: string,
  ): RescueStateRecord {
    const receipt = data.signals[eventId];
    if (!receipt) throw new Error(`未知事件标识: ${eventId}`);
    const record = data.rescues[receipt.rescueId];
    if (!record) throw new Error(`救援记录缺失: ${receipt.rescueId}`);
    return record;
  }
}
