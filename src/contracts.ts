/**
 * 跌倒事件与救援编排的对外契约。
 *
 * 设计前提（见 README 与 fixtures/fall-scenarios.json）：
 * - 设备离线、消息提供商重试都会让同一事件重复到达，因此所有外部信号带稳定 eventId，
 *   服务端按 eventId 去重，一条事件只对应一条救援链（rescueId）。
 * - 家属侧的联系人顺序、静默时段、位置分享规则通过 FamilyPolicy（见 policy.ts）描述，
 *   其中每个联系人遵循本文件的 ContactRule 结构。
 */

export type RescueState = "asking-wearer" | "contacting" | "emergency" | "resolved";

export interface FallSignal {
  /** 设备端生成的稳定事件标识，提供商重传/离线补传保持不变。 */
  eventId: string;
  wearerId: string;
  /** 腕表本地判定时刻（离线补传时远早于 receivedAt）。 */
  capturedAt: string;
  /** 服务端实际收到时刻。 */
  receivedAt: string;
  impactG: number;
  postureChanged: boolean;
  stillSeconds: number;
  /** 佩戴检测：false 表示设备离腕（例如落在沙发上）。 */
  worn: boolean;
  /** 不透明位置令牌，真实坐标由位置服务在授权后解析。 */
  locationToken?: string;
}

export interface ContactRule {
  contactId: string;
  priority: number;
  /** 静默时段（联系人本地墙钟时间，可跨午夜）；静默时段跳过该联系人但不得阻断救援。 */
  quietHours?: { from: string; to: string };
  channels: Array<"voice" | "sms" | "app">;
}

export interface RescueTimelineEntry {
  entryId: string;
  rescueId: string;
  state: RescueState;
  actorId: string;
  /** 机器可读原因码（见 TimelineReason），便于筛选与断言。 */
  reasonCode: TimelineReason;
  /** 面向家属的中文展示文案（含具体细节）；保持契约中 reason: string 的形态。 */
  reason: string;
  occurredAt: string;
}

/** 时间线条目原因码，展示文案见 REASON_LABELS。 */
export type TimelineReason =
  | "signal-received" // 首次收到候选跌倒信号（重复包不进入时间线）
  | "ask-started" // 进入佩戴者询问
  | "wearer-cancel-accepted" // 佩戴者取消被接受
  | "wearer-cancel-rejected" // 普通取消被拒（超时或高风险）
  | "contact-notify" // 联系人已成功送达
  | "contact-skipped-quiet" // 联系人处于静默时段，跳过
  | "delivery-retry" // 提供商投递失败后重试（仍属同一救援链）
  | "contact-timeout" // 联系人在时限内未确认
  | "contact-confirmed" // 联系人确认接手
  | "emergency-escalation" // 联系人链耗尽，升级急救
  | "emergency-dispatch" // 急救调度已受理
  | "emergency-acknowledged" // 急救方反馈已处置
  | "resolved"; // 救援链结束

export const REASON_LABELS: Record<TimelineReason, string> = {
  "signal-received": "收到跌倒候选信号",
  "ask-started": "开始询问佩戴者",
  "wearer-cancel-accepted": "佩戴者取消，告警关闭",
  "wearer-cancel-rejected": "佩戴者取消被拒绝",
  "contact-notify": "通知已送达联系人",
  "contact-skipped-quiet": "联系人静默时段，跳过",
  "delivery-retry": "提供商投递重试",
  "contact-timeout": "联系人超时未确认",
  "contact-confirmed": "联系人确认接手",
  "emergency-escalation": "升级急救服务",
  "emergency-dispatch": "急救调度已受理",
  "emergency-acknowledged": "急救方确认处置完成",
  resolved: "救援链结束",
};

export type AlarmRisk = "high" | "normal" | "off-wrist";

export interface RiskAssessment {
  risk: AlarmRisk;
  /** 触发高风险的特征说明，例如 "impact:3.9g"、"still:90s"、"offline-delay:210min"。 */
  features: string[];
  offlineDelaySeconds: number;
}

/** 一次升级（跳过/超时/拒绝取消/升级急救）的结构化原因，供家属查询。 */
export interface EscalationRecord {
  at: string;
  fromState: RescueState;
  reason: string;
  detail?: string;
}

export type ResolutionKind = "wearer-cancel" | "contact-confirmed" | "emergency-handled";

/** 已持久化的待触发动作，重启后据此重新安排。 */
export interface PersistedTimer {
  token: string;
  kind: "ask-timeout" | "contact-timeout" | "provider-retry";
  fireAt: string;
  /** contact-timeout / provider-retry 对应正在尝试的联系人（急救为急救方标识）。 */
  contactId?: string;
  /** 联系人在优先级列表中的下标。 */
  contactIndex?: number;
  /** 该联系人的确认窗口内已发生的投递次数（含失败重试）。 */
  deliveryAttempts?: number;
}

/** 一条事件 = 一条救援链的聚合状态。 */
export interface AlarmRecord {
  eventId: string;
  rescueId: string;
  wearerId: string;
  state: RescueState;
  risk: AlarmRisk;
  highRiskFeatures: string[];
  /** 首次收到的信号内容；重复晚到包不会覆盖质量信息。 */
  signal: FallSignal;
  firstReceivedAt: string;
  /** 0 表示只有首包；每收到一个重复包 +1。 */
  duplicateCount: number;
  duplicateReceivedAt: string[];
  askDeadline?: string;
  cancelDeadline?: string;
  attemptContactIndex: number;
  currentContactId?: string;
  /** 当前响应人：联系人标识、急救方标识；佩戴者自行取消时为空。 */
  currentResponderId?: string;
  escalations: EscalationRecord[];
  /** 单调序号，用于生成稳定 entryId。 */
  seq: number;
  pending?: PersistedTimer;
  resolution?: ResolutionKind;
  resolvedAt?: string;
}

export interface LocationGrant {
  grantId: string;
  token: string;
  eventId: string;
  rescueId: string;
  /** 唯一被授权读取者：当前响应人。 */
  readerId: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface LocationAccessRecord {
  accessId: string;
  token?: string;
  readerId: string;
  eventId?: string;
  at: string;
  allowed: boolean;
  /** ok / unknown-token / not-current-responder / revoked / expired。 */
  reason: string;
}

export interface PersistedState {
  version: 1;
  alarms: Record<string, AlarmRecord>;
  timeline: RescueTimelineEntry[];
  grants: LocationGrant[];
  accessLog: LocationAccessRecord[];
  timerSeq: number;
}

export interface EventView {
  event: AlarmRecord;
  timeline: RescueTimelineEntry[];
  escalations: EscalationRecord[];
  currentResponderId?: string;
  state: RescueState;
}
