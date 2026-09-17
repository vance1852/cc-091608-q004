import type {
  LocationAccessRecord,
  LocationGrant,
  PersistedState,
} from "./contracts.ts";
import { addSeconds } from "./policy.ts";

/**
 * 位置分享规则：
 * - 位置只向"当前响应人"开放；联系人被跳过/超时后授权立即失效，升级急救时重新授予；
 * - 每次授权都是短时窗口（policy.locationGrantSeconds）；
 * - 每次读取——无论允许还是拒绝——都写入 accessLog 留痕。
 */
export class LocationService {
  private readonly state: PersistedState;

  constructor(state: PersistedState) {
    this.state = state;
  }

  grant(input: {
    token: string;
    eventId: string;
    rescueId: string;
    readerId: string;
    now: string;
    ttlSeconds: number;
  }): LocationGrant {
    // 任何时刻一个事件只保留一份有效授权：响应人切换（或同一响应人重新授权）时，
    // 旧授权一律显式撤销；撤销历史仍可查，读取尝试继续留痕。
    for (const g of this.state.grants) {
      if (g.eventId === input.eventId && !g.revokedAt) {
        g.revokedAt = input.now;
      }
    }
    const grant: LocationGrant = {
      grantId: `grant-${input.eventId}-${input.readerId}-${this.state.grants.length + 1}`,
      token: input.token,
      eventId: input.eventId,
      rescueId: input.rescueId,
      readerId: input.readerId,
      grantedAt: input.now,
      expiresAt: addSeconds(input.now, input.ttlSeconds),
    };
    this.state.grants.push(grant);
    return grant;
  }

  /** 切换响应人或告警结束时调用：撤销该事件尚未过期的授权。 */
  revokeForEvent(eventId: string, now: string): void {
    for (const g of this.state.grants) {
      if (g.eventId === eventId && !g.revokedAt) g.revokedAt = now;
    }
  }

  /**
   * 读取位置。只有当前响应人凭有效授权才能读到坐标；
   * 所有尝试（含过期、非当前响应人、未知令牌）都留痕。
   */
  read(input: {
    token: string | undefined;
    readerId: string;
    currentResponderId: string | undefined;
    now: string;
  }): { allowed: boolean; coordinates: string | null; reason: string } {
    const record = (allowed: boolean, reason: string, eventId?: string): LocationAccessRecord => {
      const rec: LocationAccessRecord = {
        accessId: `access-${this.state.accessLog.length + 1}`,
        readerId: input.readerId,
        at: input.now,
        allowed,
        reason,
        ...(input.token !== undefined ? { token: input.token } : {}),
        ...(eventId !== undefined ? { eventId } : {}),
      };
      this.state.accessLog.push(rec);
      return rec;
    };

    if (!input.token) {
      record(false, "unknown-token");
      return { allowed: false, coordinates: null, reason: "unknown-token" };
    }
    const withToken = this.state.grants.filter((g) => g.token === input.token);
    // 优先匹配读取者本人的授权（这样"你的授权已撤销/过期"与"你从来不是响应人"可区分），
    // 读取者从未获得授权时再回落到该令牌最新的授权。
    const grant =
      [...withToken].reverse().find((g) => g.readerId === input.readerId) ??
      withToken[withToken.length - 1];
    if (!grant) {
      record(false, "unknown-token");
      return { allowed: false, coordinates: null, reason: "unknown-token" };
    }
    if (grant.revokedAt && Date.parse(grant.revokedAt) <= Date.parse(input.now)) {
      record(false, "revoked", grant.eventId);
      return { allowed: false, coordinates: null, reason: "revoked" };
    }
    if (Date.parse(input.now) > Date.parse(grant.expiresAt)) {
      record(false, "expired", grant.eventId);
      return { allowed: false, coordinates: null, reason: "expired" };
    }
    if (input.readerId !== grant.readerId || input.readerId !== input.currentResponderId) {
      record(false, "not-current-responder", grant.eventId);
      return { allowed: false, coordinates: null, reason: "not-current-responder" };
    }
    record(true, "ok", grant.eventId);
    // 真实实现中此处由令牌向设备位置平台换取坐标；样例用脱敏占位坐标。
    return { allowed: true, coordinates: `geo://resolved/${grant.token}`, reason: "ok" };
  }

  grantsFor(eventId: string): LocationGrant[] {
    return this.state.grants.filter((g) => g.eventId === eventId);
  }

  accessLogFor(eventId: string | undefined): LocationAccessRecord[] {
    return this.state.accessLog.filter((r) => (eventId ? r.eventId === eventId : true));
  }
}
