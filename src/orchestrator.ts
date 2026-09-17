import type {
  AlarmRecord,
  EscalationRecord,
  EventView,
  PersistedState,
  PersistedTimer,
  RescueState,
  RescueTimelineEntry,
  TimelineReason,
} from "./contracts.ts";
import { REASON_LABELS } from "./contracts.ts";
import { LocationService } from "./location.ts";
import {
  addSeconds,
  assessSignal,
  evaluateCancel,
  isInQuietHours,
  orderedContacts,
  type FamilyPolicy,
} from "./policy.ts";
import {
  EMERGENCY_CHANNEL,
  type DeliveryRequest,
  type NotificationProvider,
} from "./provider.ts";
import { cloneState, emptyState, type StateStore } from "./store.ts";
import type { TimerHost } from "./timers.ts";

export interface IngestResult {
  record: AlarmRecord;
  duplicate: boolean;
}

/**
 * 跌倒事件与救援编排服务。
 *
 * 不变量：
 * 1. 一条外部事件（eventId）只建立一条救援链（rescueId = rescue-<eventId>）；
 *    提供商重传与离线补传的重复包只累加 duplicateCount，绝不产生第二条时间线。
 * 2. 询问 -> 联系人确认 -> 急救升级 -> 结束 的每一次状态跃迁与"下一次动作"
 *    都在同一个原子 commit 中落盘；进程重启后按 pending 定时器继续安排。
 * 3. 普通取消只能在策略时限内关闭无高风险特征的告警；高风险告警必须走完联系人链。
 * 4. 呼叫回执、确认窗口超时、提供商重试全部汇入同一 rescueId。
 * 5. 位置只授予当前响应人且为短时授权，每次读取（允许或拒绝）都留痕。
 */
export class RescueOrchestrator {
  private state: PersistedState;
  private recovered = false;
  private taskChain: Promise<unknown> = Promise.resolve();
  /** 已写入内存状态但尚未确认落盘的新定时器；commit 成功后才真正注册。 */
  private readonly pendingSchedule = new Map<string, string>();
  readonly location: LocationService;

  private readonly store: StateStore;
  private readonly policy: FamilyPolicy;
  private readonly provider: NotificationProvider;
  private readonly timers: TimerHost;

  private constructor(
    store: StateStore,
    policy: FamilyPolicy,
    provider: NotificationProvider,
    timers: TimerHost,
    state: PersistedState,
  ) {
    this.store = store;
    this.policy = policy;
    this.provider = provider;
    this.timers = timers;
    this.state = state;
    this.location = new LocationService(this.state);
  }

  static async create(
    store: StateStore,
    policy: FamilyPolicy,
    provider: NotificationProvider,
    timers: TimerHost,
  ): Promise<RescueOrchestrator> {
    const state = (await store.load()) ?? emptyState();
    const orch = new RescueOrchestrator(store, policy, provider, timers, state);
    orch.recover();
    return orch;
  }

  // ---------------------------------------------------------------- 接收与去重

  /**
   * 接收腕表候选信号。冲击、姿态变化、静止时长与佩戴状态随首包固化；
   * 同 eventId 的晚到/重传包不覆盖任何质量信息，只记录为重复。
   */
  ingest(signal: AlarmRecord["signal"]): Promise<IngestResult> {
    return this.serialize(async () => {
      const existing = this.state.alarms[signal.eventId];
      if (existing) {
        existing.duplicateCount += 1;
        existing.duplicateReceivedAt.push(signal.receivedAt);
        await this.commit();
        return { record: cloneAlarm(existing), duplicate: true };
      }

      const assessment = assessSignal(signal, this.policy);
      const now = signal.receivedAt;
      const record: AlarmRecord = {
        eventId: signal.eventId,
        rescueId: `rescue-${signal.eventId}`,
        wearerId: signal.wearerId,
        state: "asking-wearer",
        risk: assessment.risk,
        highRiskFeatures: assessment.features,
        signal,
        firstReceivedAt: now,
        duplicateCount: 0,
        duplicateReceivedAt: [],
        askDeadline: addSeconds(now, this.policy.askTimeoutSeconds),
        cancelDeadline: addSeconds(now, this.policy.cancelWindowSeconds),
        attemptContactIndex: 0,
        escalations: [],
        seq: 0,
      };
      this.state.alarms[signal.eventId] = record;

      this.appendEntry(record, "asking-wearer", `watch:${signal.wearerId}`, "signal-received",
        assessment.risk === "off-wrist"
          ? "设备报告离腕"
          : assessment.features.length > 0
            ? `高风险特征 ${assessment.features.join("、")}`
            : `${signal.impactG}g 冲击，无高风险特征`,
        now);
      this.appendEntry(record, "asking-wearer", "system", "ask-started",
        `询问佩戴者，${this.policy.askTimeoutSeconds}s 内可取消`, now);

      // 询问窗口自服务端实际收到（离线补传到达）时起算；补传的长延迟本身
      // 已作为高风险特征记录，佩戴者普通取消无法关闭这类告警。
      this.armTimer(record, {
        kind: "ask-timeout",
        fireAt: record.askDeadline!,
      });
      await this.commit();
      return { record: cloneAlarm(record), duplicate: false };
    });
  }

  // ---------------------------------------------------------------- 佩戴者取消

  /** 佩戴者（或家属在设备/APP 上）声明误触，请求取消。 */
  cancelByWearer(eventId: string, atIso = this.timers.now()): Promise<{ accepted: boolean; reason?: string }> {
    return this.serialize(async () => {
      const record = this.require(eventId);
      if (record.state === "resolved") return { accepted: false, reason: "already-resolved" };

      const verdict = evaluateCancel(
        record.risk,
        record.highRiskFeatures,
        record.cancelDeadline!,
        atIso,
      );
      if (!verdict.accepted) {
        this.appendEntry(record, record.state, `wearer:${record.wearerId}`,
          "wearer-cancel-rejected",
          verdict.reason === "high-risk"
            ? `高风险告警不可普通取消（${record.highRiskFeatures.join("、")}），继续救援`
            : `已超过取消时限 ${record.cancelDeadline}，继续救援`);
        record.escalations.push(this.escalation(record.state, "cancel-rejected",
          verdict.reason === "high-risk" ? "高风险特征阻断普通取消" : "取消超过策略时限"));
        await this.commit();
        return { accepted: false, reason: verdict.reason };
      }

      this.clearTimer(record);
      this.location.revokeForEvent(eventId, atIso);
      this.resolve(record, "wearer-cancel", `wearer:${record.wearerId}`,
        "wearer-cancel-accepted", "佩戴者确认误触，告警关闭", atIso);
      await this.commit();
      return { accepted: true };
    });
  }

  // ---------------------------------------------------------------- 联系人确认

  /**
   * 联系人回执：确认接手救援。只接受"当前响应人"的确认；
   * 更早/更晚顺位联系人的回执不影响当前链路（避免乱序回执打乱顺序）。
   */
  confirmByContact(
    eventId: string,
    contactId: string,
    atIso = this.timers.now(),
  ): Promise<{ accepted: boolean }> {
    return this.serialize(async () => {
      const record = this.require(eventId);
      if (record.state !== "contacting" || record.currentContactId !== contactId) {
        return { accepted: false };
      }
      this.clearTimer(record);
      this.location.revokeForEvent(eventId, atIso);
      this.resolve(record, "contact-confirmed", contactId,
        "contact-confirmed", `联系人 ${contactId} 确认接手，救援链结束`, atIso);
      await this.commit();
      return { accepted: true };
    });
  }

  /** 急救方反馈现场已处置。 */
  acknowledgeEmergency(eventId: string, atIso = this.timers.now()): Promise<{ accepted: boolean }> {
    return this.serialize(async () => {
      const record = this.require(eventId);
      if (record.state !== "emergency" || record.currentResponderId !== this.policy.emergencyResponderId) {
        return { accepted: false };
      }
      this.clearTimer(record);
      this.appendEntry(record, "emergency", this.policy.emergencyResponderId,
        "emergency-acknowledged", "急救方反馈已到场处置", atIso);
      this.location.revokeForEvent(eventId, atIso);
      this.resolve(record, "emergency-handled", this.policy.emergencyResponderId,
        "resolved", "急救处置完成，救援链结束", atIso);
      await this.commit();
      return { accepted: true };
    });
  }

  // ---------------------------------------------------------------- 定时跃迁

  private async onAskTimeout(token: string): Promise<void> {
    await this.serialize(async () => {
      const record = this.byTimer(token, "ask-timeout");
      if (!record || record.state !== "asking-wearer") return;
      this.clearTimer(record);
      record.escalations.push(this.escalation("asking-wearer", "ask-timeout",
        `佩戴者在 ${this.policy.askTimeoutSeconds}s 询问窗口内未取消`));
      await this.startContactAttempt(record, 0);
    });
  }

  private async startContactAttempt(record: AlarmRecord, index: number): Promise<void> {
    const contacts = orderedContacts(this.policy);
    record.state = "contacting";
    if (index >= contacts.length) {
      await this.escalateToEmergency(record, `全部 ${contacts.length} 位联系人未能确认`);
      return;
    }
    const rule = contacts[index]!;
    record.attemptContactIndex = index;

    if (isInQuietHours(rule, this.timers.now(), this.policy.quietHoursTimeZone)) {
      // 静默只跳过本人，立即顺延，不产生等待窗口——静默不得阻断救援。
      this.appendEntry(record, "contacting", rule.contactId, "contact-skipped-quiet",
        `联系人 ${rule.contactId} 处于静默时段 ${rule.quietHours!.from}-${rule.quietHours!.to}，顺延下一位`);
      record.escalations.push(this.escalation(record.state, "contact-skipped-quiet",
        `${rule.contactId} 静默时段跳过`));
      await this.startContactAttempt(record, index + 1);
      return;
    }

    record.currentContactId = rule.contactId;
    record.currentResponderId = rule.contactId;
    await this.deliverToContact(record, rule.contactId, rule.channels[0]!, 1);
  }
  /** 统一包裹提供商调用：网络异常等抛出与结构化 failed 一样汇入重试链。 */
  private async attemptDelivery(req: DeliveryRequest) {
    try {
      return await this.provider.send(req);
    } catch (err) {
      const errorCode = err instanceof Error ? err.name || "PROVIDER_ERROR" : "PROVIDER_ERROR";
      return { outcome: "failed" as const, errorCode, retryable: true };
    }
  }

  private async deliverToContact(
    record: AlarmRecord,
    contactId: string,
    channel: DeliveryRequest["channel"],
    attempt: number,
  ): Promise<void> {
    const result = await this.attemptDelivery({
      rescueId: record.rescueId,
      eventId: record.eventId,
      recipientId: contactId,
      channel,
      attempt,
    });

    if (result.outcome === "delivered") {
      this.appendEntry(record, "contacting", contactId, "contact-notify",
        attempt === 1
          ? `已通过 ${channel} 呼叫联系人 ${contactId}，等待 ${this.policy.contactTimeoutSeconds}s 确认`
          : `第 ${attempt} 次投递经 ${channel} 送达 ${contactId}`);
      // 位置仅对当前响应人短时开放。
      if (record.signal.locationToken) {
        this.location.grant({
          token: record.signal.locationToken,
          eventId: record.eventId,
          rescueId: record.rescueId,
          readerId: contactId,
          now: this.timers.now(),
          ttlSeconds: this.policy.locationGrantSeconds,
        });
      }
      this.armTimer(record, {
        kind: "contact-timeout",
        fireAt: addSeconds(this.timers.now(), this.policy.contactTimeoutSeconds),
        contactId,
        contactIndex: record.attemptContactIndex,
        deliveryAttempts: attempt,
      });
      await this.commit();
      return;
    }

    // 投递失败：可重试错误在同一联系人的确认窗口内重投，仍属同一条救援链。
    record.escalations.push(this.escalation("contacting", "delivery-failed",
      `${contactId} 第 ${attempt} 次投递失败：${result.errorCode}${result.retryable ? "（可重试）" : ""}`));
    if (result.retryable && attempt < this.policy.maxDeliveryAttempts) {
      this.appendEntry(record, "contacting", contactId, "delivery-retry",
        `提供商 ${result.errorCode}，${this.policy.retryDelaySeconds}s 后第 ${attempt + 1} 次重试`);
      this.armTimer(record, {
        kind: "provider-retry",
        fireAt: addSeconds(this.timers.now(), this.policy.retryDelaySeconds),
        contactId,
        contactIndex: record.attemptContactIndex,
        deliveryAttempts: attempt,
      });
      await this.commit();
      return;
    }

    this.appendEntry(record, "contacting", contactId, "contact-timeout",
      `联系人 ${contactId} 不可达（投递 ${attempt} 次），顺延下一位`);
    this.clearTimer(record);
    this.location.revokeForEvent(record.eventId, this.timers.now());
    await this.startContactAttempt(record, record.attemptContactIndex + 1);
  }

  private async onProviderRetry(token: string): Promise<void> {
    await this.serialize(async () => {
      const record = this.byTimer(token, "provider-retry");
      const pending = record?.pending;
      if (!record || !pending || pending.contactId === undefined || pending.deliveryAttempts === undefined) return;

      // 急救呼叫失败的重试：contactIndex === -1 标记急救方，不受联系人链窗口限制。
      if (record.state === "emergency" && pending.contactId === this.policy.emergencyResponderId) {
        this.clearTimer(record);
        await this.deliverEmergency(record, pending.deliveryAttempts + 1);
        return;
      }

      if (record.state !== "contacting" || record.currentContactId !== pending.contactId) return;
      this.clearTimer(record);
      const rule = orderedContacts(this.policy).find((c) => c.contactId === pending.contactId)!;
      await this.deliverToContact(record, pending.contactId, rule.channels[0]!, pending.deliveryAttempts + 1);
    });
  }

  private async onContactTimeout(token: string): Promise<void> {
    await this.serialize(async () => {
      const record = this.byTimer(token, "contact-timeout");
      const pending = record?.pending;
      if (!record || !pending || record.state !== "contacting") return;
      if (record.currentContactId !== pending.contactId) return;
      this.clearTimer(record);
      this.appendEntry(record, "contacting", pending.contactId!, "contact-timeout",
        `联系人 ${pending.contactId} 在 ${this.policy.contactTimeoutSeconds}s 内未确认，顺延下一位`);
      record.escalations.push(this.escalation("contacting", "contact-timeout",
        `${pending.contactId} 确认超时`));
      this.location.revokeForEvent(record.eventId, this.timers.now());
      await this.startContactAttempt(record, (pending.contactIndex ?? 0) + 1);
    });
  }

  // ---------------------------------------------------------------- 急救升级

  private async escalateToEmergency(record: AlarmRecord, why: string): Promise<void> {
    const emergencyId = this.policy.emergencyResponderId;
    record.state = "emergency";
    delete record.currentContactId;
    record.currentResponderId = emergencyId;
    record.escalations.push(this.escalation("contacting", "emergency-escalation", why));
    this.appendEntry(record, "emergency", "system", "emergency-escalation",
      `联系人链耗尽：${why}，升级急救 ${emergencyId}`);

    // 急救升级不允许被提供商故障阻断：失败即按重试间隔一直重呼，直到收到受理回执。
    await this.deliverEmergency(record, 1);
  }

  private async deliverEmergency(record: AlarmRecord, attempt: number): Promise<void> {
    const emergencyId = this.policy.emergencyResponderId;
    const result = await this.attemptDelivery({
      rescueId: record.rescueId,
      eventId: record.eventId,
      recipientId: emergencyId,
      channel: EMERGENCY_CHANNEL,
      attempt,
    });
    if (result.outcome === "delivered") {
      this.appendEntry(record, "emergency", emergencyId, "emergency-dispatch",
        attempt === 1
          ? `急救调度 ${emergencyId} 已受理（回执 ${result.receiptId}）`
          : `急救调度第 ${attempt} 次呼叫已受理（回执 ${result.receiptId}）`);
      if (record.signal.locationToken) {
        this.location.grant({
          token: record.signal.locationToken,
          eventId: record.eventId,
          rescueId: record.rescueId,
          readerId: emergencyId,
          now: this.timers.now(),
          ttlSeconds: this.policy.locationGrantSeconds,
        });
      }
      await this.commit();
      return;
    }
    this.appendEntry(record, "emergency", emergencyId, "delivery-retry",
      `急救呼叫失败 ${result.errorCode}，${this.policy.retryDelaySeconds}s 后重呼（第 ${attempt + 1} 次）`);
    record.escalations.push(this.escalation("emergency", "emergency-retry",
      `急救第 ${attempt} 次呼叫失败：${result.errorCode}`));
    this.armTimer(record, {
      kind: "provider-retry",
      fireAt: addSeconds(this.timers.now(), this.policy.retryDelaySeconds),
      contactId: emergencyId,
      contactIndex: -1,
      deliveryAttempts: attempt,
    });
    await this.commit();
  }

  // ---------------------------------------------------------------- 位置读取

  /**
   * 当前响应人凭事件位置令牌读取坐标；非响应人/过期/撤销/未知令牌全部拒绝。
   * 读取本身（允许或拒绝）与时间线跃迁共用串行锁并在同一事务落盘，保证留痕不丢。
   */
  readLocation(eventId: string, readerId: string, atIso = this.timers.now()) {
    return this.serialize(async () => {
      const record = this.state.alarms[eventId];
      const result = this.location.read({
        token: record?.signal.locationToken,
        readerId,
        currentResponderId: record?.currentResponderId,
        now: atIso,
      });
      await this.commit();
      return result;
    });
  }

  /** 位置读取留痕（含被拒绝的尝试），可按事件过滤。只读，不产生状态变更。 */
  locationAccessLog(eventId?: string) {
    return this.location.accessLogFor(eventId).map((r) => ({ ...r }));
  }

  // ---------------------------------------------------------------- 查询

  /** 家属查询：唯一时间线、升级原因、当前响应人；顺序与写入顺序一致。 */
  getEvent(eventId: string): EventView | undefined {
    const event = this.state.alarms[eventId];
    if (!event) return undefined;
    const timeline = this.state.timeline
      .filter((e) => e.rescueId === event.rescueId)
      .sort(compareEntries);
    return {
      event: cloneAlarm(event),
      timeline: timeline.map((e) => ({ ...e })),
      escalations: event.escalations.map((e) => ({ ...e })),
      state: event.state,
      ...(event.currentResponderId !== undefined ? { currentResponderId: event.currentResponderId } : {}),
    };
  }

  /** 跨事件列表：按首次收到时间稳定排序（晚到的旧事件按其实际收到时刻归位）。 */
  listEvents(): EventView[] {
    return Object.values(this.state.alarms)
      .sort((a, b) => {
        const ta = Date.parse(a.firstReceivedAt);
        const tb = Date.parse(b.firstReceivedAt);
        if (ta !== tb) return ta - tb;
        return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
      })
      .map((a) => this.getEvent(a.eventId)!);
  }

  // ---------------------------------------------------------------- 内部机制

  /** 简易串行锁：同一编排器的所有外部输入与定时跃迁按提交顺序执行。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.taskChain.then(fn, fn);
    this.taskChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private require(eventId: string): AlarmRecord {
    const record = this.state.alarms[eventId];
    if (!record) throw new Error(`unknown event: ${eventId}`);
    return record;
  }

  private appendEntry(
    record: AlarmRecord,
    state: RescueState,
    actorId: string,
    reasonCode: TimelineReason,
    detail: string,
    atIso = this.timers.now(),
  ): RescueTimelineEntry {
    record.seq += 1;
    const label = REASON_LABELS[reasonCode];
    const entry: RescueTimelineEntry = {
      entryId: `${record.rescueId}-${String(record.seq).padStart(3, "0")}`,
      rescueId: record.rescueId,
      state,
      actorId,
      reasonCode,
      reason: detail ? `${label}：${detail}` : label,
      occurredAt: atIso,
    };
    this.state.timeline.push(entry);
    return entry;
  }

  private escalation(fromState: RescueState, reason: string, detail?: string): EscalationRecord {
    return { at: this.timers.now(), fromState, reason, ...(detail ? { detail } : {}) };
  }

  private resolve(
    record: AlarmRecord,
    kind: NonNullable<AlarmRecord["resolution"]>,
    actorId: string,
    reason: TimelineReason,
    detail: string,
    atIso: string,
  ): void {
    record.state = "resolved";
    record.resolution = kind;
    record.resolvedAt = atIso;
    delete record.currentResponderId;
    this.appendEntry(record, "resolved", actorId, reason, detail, atIso);
  }

  private armTimer(record: AlarmRecord, timer: Omit<PersistedTimer, "token">): void {
    this.clearTimer(record);
    const token = `timer-${this.state.timerSeq++}`;
    record.pending = { ...timer, token };
    // 先随状态落盘，commit() 成功后再注册（见 flushSchedules）；
    // 若落盘前进程退出，重启后由 recover() 依据持久化的 pending 补注册。
    this.pendingSchedule.set(token, timer.fireAt);
  }

  private clearTimer(record: AlarmRecord): void {
    if (record.pending) {
      this.timers.cancel(record.pending.token);
      this.pendingSchedule.delete(record.pending.token);
      delete record.pending;
    }
  }

  private async route(token: string): Promise<void> {
    const descriptor = this.findTimer(token);
    if (!descriptor) return;
    if (descriptor.kind === "ask-timeout") return this.onAskTimeout(token);
    if (descriptor.kind === "contact-timeout") return this.onContactTimeout(token);
    return this.onProviderRetry(token);
  }

  private findTimer(token: string): PersistedTimer | undefined {
    for (const record of Object.values(this.state.alarms)) {
      if (record.pending?.token === token) return record.pending;
    }
    return undefined;
  }

  private byTimer(token: string, kind: PersistedTimer["kind"]): AlarmRecord | undefined {
    for (const record of Object.values(this.state.alarms)) {
      if (record.pending?.token === token && record.pending.kind === kind) return record;
    }
    return undefined;
  }

  /**
   * 重启恢复：为每个未结束告警的持久化 pending 动作重新注册定时器。
   * fireAt 已过（例如停机数小时，正对应离线补传当天的情形）时立即补跑，
   * 因此"服务中途重启，仍继续安排下一次动作"。
   */
  private recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    for (const record of Object.values(this.state.alarms)) {
      if (record.state === "resolved" || !record.pending) continue;
      this.timers.schedule(record.pending.token, record.pending.fireAt, () => this.route(record.pending!.token));
    }
  }

  private async commit(): Promise<void> {
    await this.store.commit(cloneState(this.state));
    // 落盘成功后才安排下一次动作，保证存储与定时器一致。
    for (const [token, fireAt] of this.pendingSchedule) {
      this.timers.schedule(token, fireAt, () => this.route(token));
    }
    this.pendingSchedule.clear();
  }
}

function compareEntries(a: RescueTimelineEntry, b: RescueTimelineEntry): number {
  // 不同时区写法（+08:00 / Z）表示同一时刻，必须按实际时刻排序而非字符串比较。
  const ta = Date.parse(a.occurredAt);
  const tb = Date.parse(b.occurredAt);
  if (ta !== tb) return ta - tb;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

function cloneAlarm(record: AlarmRecord): AlarmRecord {
  return structuredClone(record);
}
