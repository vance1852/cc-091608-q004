import { renameSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import type {
  FallSignal,
  RescueState,
  RescueTimelineEntry,
} from "./contracts.js";
import type { RiskAssessment } from "./policy.js";

export type Channel = "voice" | "sms" | "app";

/** 冻结在救援记录上的联络计划：联系人顺序与渠道在进入联系阶段时确定，
 * 重启后仍按同一条链推进，不受之后策略变动影响。 */
export interface PlanEntry {
  contactId: string;
  channel: Channel;
}

/** 一次具体的呼叫尝试：联系人 + 渠道，承载提供商重试与回执状态。 */
export interface Attempt {
  attemptId: string;
  seq: number;
  contactId: string;
  channel: Channel;
  /** 提供商已投递次数（1 为首发）。 */
  providerTries: number;
  status:
    | "pending"
    | "awaiting-confirmation"
    | "confirmed"
    | "declined"
    | "expired"
    | "skipped"
    | "failed"
    | "dispatched";
  providerMessageId?: string | undefined;
  reason?: string | undefined;
  startedAt: number;
  dueAt?: number | undefined;
  finishedAt?: number | undefined;
}

/** 已安排但尚未发生的下一次动作；服务重启后据此继续。 */
export type PendingAction =
  | { kind: "ask-timeout"; dueAt: number }
  | { kind: "attempt-timeout"; seq: number; dueAt: number }
  | { kind: "provider-retry"; seq: number; triesSoFar: number; dueAt: number };

export type Resolution =
  | "wearer-cancelled"
  | "confirmed-by-contact"
  | "emergency-dispatched";

export interface LocationGrant {
  token: string;
  contactId: string;
  grantedAt: number;
  expiresAt: number;
  active: boolean;
  revokeReason?: string;
}

export interface LocationAuditEntry {
  auditId: string;
  action: "grant" | "read" | "revoke";
  token: string;
  contactId: string;
  at: number;
  allowed: boolean;
  reason: string;
}

export interface RescueStateRecord {
  schema: 1;
  rescueId: string;
  eventId: string;
  wearerId: string;
  signal: FallSignal;
  risk: RiskAssessment;
  state: RescueState;
  resolution?: Resolution | undefined;
  askStartedAt?: number | undefined;
  plan: PlanEntry[];
  attempts: Attempt[];
  /** 当前正在响应的联系人；急救阶段为 emergency-services。 */
  currentResponderId?: string | undefined;
  pendingAction?: PendingAction | undefined;
  nextActionAt?: number | undefined;
  emergencyDispatched: boolean;
  timeline: RescueTimelineEntry[];
  location?:
    | {
        token: string;
        grants: LocationGrant[];
        audit: LocationAuditEntry[];
      }
    | undefined;
  counter: number;
  createdAt: number;
  updatedAt: number;
}

export interface SignalReceipt {
  eventId: string;
  rescueId: string;
  firstReceivedAt: string;
  /** 同一事件标识的重复送达次数（含首发为 1）。 */
  deliveryCount: number;
}

export interface StoreData {
  version: 1;
  signals: Record<string, SignalReceipt>;
  rescues: Record<string, RescueStateRecord>;
}

export interface RescueStore {
  load(): StoreData;
  save(data: StoreData): void;
}

export function emptyStoreData(): StoreData {
  return { version: 1, signals: {}, rescues: {} };
}

/** 原子写入的 JSON 存储：先写临时文件再 rename，避免重启读到半写状态。 */
export class JsonRescueStore implements RescueStore {
  constructor(private readonly path: string) {}

  load(): StoreData {
    try {
      const raw = readFileSync(this.path, "utf8");
      const data = JSON.parse(raw) as StoreData;
      if (data.version !== 1) {
        throw new Error(`不支持的存储版本: ${String(data.version)}`);
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyStoreData();
      }
      throw error;
    }
  }

  save(data: StoreData): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}

/** 进程内存储，供回放与测试使用。 */
export class MemoryRescueStore implements RescueStore {
  private data: StoreData = emptyStoreData();

  load(): StoreData {
    // 返回结构化深拷贝，调用方只通过 save 提交，语义与 JSON 存储一致。
    return JSON.parse(JSON.stringify(this.data)) as StoreData;
  }

  save(data: StoreData): void {
    this.data = JSON.parse(JSON.stringify(data)) as StoreData;
  }
}
