import type {
  AlarmRisk,
  ContactRule,
  FallSignal,
  RiskAssessment,
} from "./contracts.ts";

/**
 * 家属侧策略：联系人顺序、静默时段与位置分享规则。
 * 联系人顺序/静默时段沿用 contracts.ts 的 ContactRule；其余阈值集中在此，
 * 便于家属按佩戴者情况调整。
 */
export interface FamilyPolicy {
  wearerId: string;
  contacts: ContactRule[];
  /** 佩戴者询问窗口：高风险冲击下先短问，超时即通知联系人。 */
  askTimeoutSeconds: number;
  /**
   * 普通取消的有效时限（自首次收到信号起）。
   * 超过此时限的取消不再被接受；高风险告警任何时刻都不能被普通取消直接关闭。
   */
  cancelWindowSeconds: number;
  /** 单个联系人的确认窗口，超时即顺延下一位。 */
  contactTimeoutSeconds: number;
  /** 急救方标识（联系人链耗尽后的升级目标，视为最高优先级响应人）。 */
  emergencyResponderId: string;
  /** 静默时段按联系人所在时区解释墙钟时间（IANA 时区名）。 */
  quietHoursTimeZone: string;
  /** 位置授权只对当前响应人开放的时长。 */
  locationGrantSeconds: number;
  /** 提供商投递失败后的重试间隔（重试仍汇入同一条救援链）。 */
  retryDelaySeconds: number;
  /** 同一联系人确认窗口内的最大投递尝试次数，超过则视为该联系人不可达。 */
  maxDeliveryAttempts: number;
  thresholds: {
    /** 冲击达到该值视为高风险特征。 */
    impactG: number;
    /** 静止达到该秒数视为高风险特征。 */
    stillSeconds: number;
    /** 离线补传延迟达到该分钟数视为高风险特征。 */
    offlineDelayMinutes: number;
  };
}

export const DEFAULT_POLICY: FamilyPolicy = {
  wearerId: "elder-08",
  // priority 越小越优先。
  contacts: [
    {
      contactId: "daughter",
      priority: 1,
      quietHours: { from: "23:00", to: "07:00" },
      channels: ["voice", "sms", "app"],
    },
    {
      contactId: "son",
      priority: 2,
      channels: ["voice", "app"],
    },
    {
      contactId: "community-doctor",
      priority: 3,
      quietHours: { from: "22:00", to: "08:00" },
      channels: ["voice"],
    },
  ],
  askTimeoutSeconds: 30,
  cancelWindowSeconds: 60,
  contactTimeoutSeconds: 120,
  emergencyResponderId: "emergency-120",
  quietHoursTimeZone: "Asia/Shanghai",
  locationGrantSeconds: 600,
  retryDelaySeconds: 20,
  maxDeliveryAttempts: 3,
  thresholds: {
    impactG: 3.0,
    stillSeconds: 60,
    offlineDelayMinutes: 60,
  },
};

function isoTimeMs(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid ISO time: ${iso}`);
  return t;
}

export function secondsBetween(fromIso: string, toIso: string): number {
  return Math.round((isoTimeMs(toIso) - isoTimeMs(fromIso)) / 1000);
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(isoTimeMs(iso) + seconds * 1000).toISOString();
}

/**
 * 依据信号质量信息分级：
 * - off-wrist：未佩戴，典型为设备落在沙发上，进入询问而不是直接惊动联系人；
 * - high：任一高风险特征成立（强冲击、姿态改变且长静止、长时间离线补传）；
 * - normal：其余候选。
 * 高风险特征会被记录，用于拒绝普通取消与向家属解释升级原因。
 */
export function assessSignal(signal: FallSignal, policy: FamilyPolicy): RiskAssessment {
  const offlineDelaySeconds = Math.max(
    0,
    secondsBetween(signal.capturedAt, signal.receivedAt),
  );
  const features: string[] = [];

  if (!signal.worn) {
    return { risk: "off-wrist", features, offlineDelaySeconds };
  }
  if (signal.impactG >= policy.thresholds.impactG) {
    features.push(`impact:${signal.impactG}g`);
  }
  if (signal.postureChanged && signal.stillSeconds >= policy.thresholds.stillSeconds) {
    features.push(`posture-change+still:${signal.stillSeconds}s`);
  }
  if (offlineDelaySeconds >= policy.thresholds.offlineDelayMinutes * 60) {
    features.push(`offline-delay:${Math.round(offlineDelaySeconds / 60)}min`);
  }
  return {
    risk: features.length > 0 ? "high" : "normal",
    features,
    offlineDelaySeconds,
  };
}

export function isHighRisk(risk: AlarmRisk): boolean {
  return risk === "high";
}

/** HH:MM 墙钟时刻。 */
function wallMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid wall time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 取某一 UTC 时刻在给定 IANA 时区下的当日分钟数（0-1439）。 */
function wallMinutesInZone(atIso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(isoTimeMs(atIso)));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // 部分环境午夜以 24 表示。
  return hour * 60 + get("minute");
}

/**
 * 判断联系人在给定时刻是否处于静默时段。静默只跳过该联系人，
 * 编排器必须继续尝试后续联系人或升级急救——静默不得阻断救援。
 * 墙钟时间按联系人所在时区（policy.quietHoursTimeZone）解释。
 */
export function isInQuietHours(rule: ContactRule, atIso: string, timeZone: string): boolean {
  if (!rule.quietHours) return false;
  const start = wallMinutes(rule.quietHours.from);
  const end = wallMinutes(rule.quietHours.to);
  const now = wallMinutesInZone(atIso, timeZone);
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  // 跨午夜。
  return now >= start || now < end;
}

/** 按 priority 升序返回联系人副本。 */
export function orderedContacts(policy: FamilyPolicy): ContactRule[] {
  return [...policy.contacts].sort((a, b) => a.priority - b.priority);
}

export type CancelVerdict =
  | { accepted: true }
  | { accepted: false; reason: "high-risk" | "window-expired" };

/**
 * 普通取消只在策略时限内有效，且永远不能直接关闭带高风险特征的告警。
 */
export function evaluateCancel(
  risk: AlarmRisk,
  highRiskFeatures: string[],
  cancelDeadlineIso: string,
  atIso: string,
): CancelVerdict {
  if (risk === "high" || highRiskFeatures.length > 0) {
    return { accepted: false, reason: "high-risk" };
  }
  if (isoTimeMs(atIso) > isoTimeMs(cancelDeadlineIso)) {
    return { accepted: false, reason: "window-expired" };
  }
  return { accepted: true };
}
