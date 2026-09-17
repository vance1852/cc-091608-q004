import type { Channel } from "./state.js";

export interface NotificationRequest {
  rescueId: string;
  seq: number;
  contactId: string;
  channel: Channel;
  emergency: boolean;
  wearerId: string;
  text: string;
  /** 仅随当前响应者的通知下发的短时位置令牌。 */
  locationToken?: string | undefined;
}

export interface DeliveryResult {
  /** 提供商网关是否受理；false 表示可重试的临时失败。 */
  accepted: boolean;
  providerMessageId?: string;
  reason?: string;
}

/** 通知提供商端口。生产适配器在此完成真实语音/短信/推送 IO。 */
export interface NotificationPort {
  send(request: NotificationRequest): DeliveryResult;
}

/**
 * 可编排的脚本提供商：按 (联系人, 渠道) 预置前若干次失败，
 * 用于把“提供商重试”汇入同一条救援链进行确定性演示。
 */
export class ScriptedNotificationProvider implements NotificationPort {
  readonly sends: NotificationRequest[] = [];
  private readonly failBudget = new Map<string, number>();
  private seq = 0;

  /** 让某联系人的某渠道前 failTimes 次投递临时失败。 */
  failFirst(contactId: string, channel: Channel, failTimes: number): this {
    this.failBudget.set(`${contactId}:${channel}`, failTimes);
    return this;
  }

  send(request: NotificationRequest): DeliveryResult {
    this.sends.push(request);
    const key = `${request.contactId}:${request.channel}`;
    const remaining = this.failBudget.get(key) ?? 0;
    if (remaining > 0) {
      this.failBudget.set(key, remaining - 1);
      return { accepted: false, reason: "provider-5xx-gateway-timeout" };
    }
    this.seq += 1;
    return {
      accepted: true,
      providerMessageId: `msg-${String(this.seq).padStart(4, "0")}`,
    };
  }
}

export const EMERGENCY_CONTACT_ID = "emergency-services";
