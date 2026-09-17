import type { ContactRule, FallSignal } from "./contracts.js";

/** 离线判定：信号从采集到送达超过该阈值即视为离线补传。 */
export const OFFLINE_DELAY_MS = 5 * 60 * 1000;

/** 高风险特征阈值（任一命中即带高风险标记）。 */
export const HIGH_RISK_IMPACT_G = 3.0;
export const HIGH_RISK_STILL_SECONDS = 60;

/** 佩戴者普通取消有效的策略时限（自告警首次进入询问态起）。 */
export const CANCEL_WINDOW_MS = 30 * 1000;

/** 佩戴者询问等待时长，超时未取消即视为求助确认。 */
export const ASK_WEARER_TIMEOUT_MS = 30 * 1000;

/** 联系人单次呼叫在升级前的等待（回执 / 接听 / 按键确认）时长。 */
export const CONTACT_ATTEMPT_TIMEOUT_MS = 60 * 1000;

/** 提供商失败后的重试间隔。 */
export const PROVIDER_RETRY_DELAY_MS = 15 * 1000;

/** 同一尝试的最大提供商重试次数（不含首发）。 */
export const MAX_PROVIDER_RETRIES = 2;

/** 急救前每个联系人最多尝试的渠道数上限（防止策略配置错误导致无限呼叫）。 */
export const MAX_CHANNELS_PER_CONTACT = 3;

/** 位置向当前响应者开放的最长时长；响应者切换时立即收回。 */
export const LOCATION_TTL_MS = 10 * 60 * 1000;

export interface HighRiskFeatures {
  strongImpact: boolean;
  prolongedStillness: boolean;
  postureChanged: boolean;
  notWorn: boolean;
  offline: boolean;
}

export interface RiskAssessment {
  features: HighRiskFeatures;
  /** 带高风险特征：强冲击、长时间静止或明显姿态变化。 */
  highRisk: boolean;
  /** 设备未佩戴：典型的“落在沙发上”误触，先询问佩戴者。 */
  credibility: "credible" | "suspectedFalseTrigger" | "stale";
  offlineDelayMs: number;
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** 依据冲击、姿态、静止时长、佩戴状态与送达质量评估候选。 */
export function assessSignal(
  signal: FallSignal,
  now: Date = new Date(),
): RiskAssessment {
  const offlineDelayMs = Math.max(
    0,
    toTime(signal.receivedAt) - toTime(signal.capturedAt),
  );
  const strongImpact = signal.impactG >= HIGH_RISK_IMPACT_G;
  const prolongedStillness = signal.stillSeconds >= HIGH_RISK_STILL_SECONDS;
  const features: HighRiskFeatures = {
    strongImpact,
    prolongedStillness,
    postureChanged: signal.postureChanged,
    notWorn: !signal.worn,
    offline: offlineDelayMs > OFFLINE_DELAY_MS,
  };
  const highRisk = strongImpact || prolongedStillness || signal.postureChanged;

  // 事件早已发生、数小时后才补传：现场窗口已过，标记为陈旧，
  // 但仍须走联系人确认而不是悄悄丢弃。
  const ageMs = Math.max(0, now.getTime() - toTime(signal.capturedAt));
  const stale = ageMs > 60 * 60 * 1000;
  const credibility = !signal.worn
    ? "suspectedFalseTrigger"
    : stale
      ? "stale"
      : "credible";

  return { features, highRisk, credibility, offlineDelayMs };
}

/**
 * 普通取消只有在策略时限内、且告警不带高风险特征时才能关闭。
 * 未佩戴的误触候选不含高风险特征，可由佩戴者在时限内取消。
 */
export function canWearerCancel(params: {
  highRisk: boolean;
  askStartedAt: number;
  at: number;
}): boolean {
  if (params.highRisk) return false;
  return params.at - params.askStartedAt <= CANCEL_WINDOW_MS;
}

function parseHHMM(hhmm: string): number {
  const [hh, mm] = hhmm.split(":").map((part) => Number(part));
  return (hh ?? 0) * 60 + (mm ?? 0);
}

/**
 * 判断某联系人在给定时刻是否处于静默时段。支持跨午夜区间（from > to）。
 * 静默期间跳过该联系人的非紧急渠道，直接顺位给下一响应者；急救不受限。
 * timeZone 为 IANA 时区；缺省使用运行机本地时区。
 */
export function isInQuietHours(
  rule: ContactRule,
  at: Date,
  timeZone?: string,
): boolean {
  if (!rule.quietHours) return false;
  const minutes = timeZone
    ? wallClockMinutes(at, timeZone)
    : at.getHours() * 60 + at.getMinutes();
  const from = parseHHMM(rule.quietHours.from);
  const to = parseHHMM(rule.quietHours.to);
  if (from === to) return false;
  return from < to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to;
}

/** 取某时刻在指定时区的挂钟分钟数（静默时段按家属所在地时区解释）。 */
function wallClockMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

/** 按优先级返回联系人（priority 数值越小越优先），同级按标识稳定排序。 */
export function sortContactRules(rules: readonly ContactRule[]): ContactRule[] {
  return [...rules].sort(
    (a, b) => a.priority - b.priority || a.contactId.localeCompare(b.contactId),
  );
}
