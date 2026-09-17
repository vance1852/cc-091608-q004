/**
 * 通知提供商端口。
 *
 * 呼叫回执（delivered）、超时（由编排器的确认窗口负责）和提供商重试
 * （failed -> 间隔重投）全部围绕同一个 rescueId 发生，不另起救援链。
 */
export type Channel = "voice" | "sms" | "app";

export interface DeliveryRequest {
  rescueId: string;
  eventId: string;
  /** 联系人或急救方标识。 */
  recipientId: string;
  channel: Channel;
  /** 该接收者确认窗口内的第几次投递（从 1 开始）。 */
  attempt: number;
}

export type DeliveryResult =
  | { outcome: "delivered"; receiptId: string }
  | { outcome: "failed"; errorCode: string; retryable: boolean };

export interface NotificationProvider {
  send(request: DeliveryRequest): Promise<DeliveryResult>;
}

/** 测试/回放用脚本提供商：按接收者与尝试次数给出确定性回执。 */
export class ScriptedProvider implements NotificationProvider {
  readonly sent: DeliveryRequest[] = [];

  /**
   * 失败尝试表，键支持两种形式：
   * - "<recipientId>"：该接收者所有事件的第 N 次投递失败；
   * - "<eventId>:<recipientId>"：仅某条救援链内失败（不同事件互不影响）。
   * 值为需要失败的尝试次数集合，其余尝试成功。
   */
  private readonly failAttempts: Record<string, number[]>;
  private readonly errorCode: string;

  constructor(
    failAttempts: Record<string, number[]> = {},
    errorCode = "PROVIDER_TIMEOUT",
  ) {
    this.failAttempts = failAttempts;
    this.errorCode = errorCode;
  }

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    this.sent.push({ ...request });
    // 让出事件循环，模拟真实异步 I/O。
    await Promise.resolve();
    const scoped = this.failAttempts[`${request.eventId}:${request.recipientId}`];
    const global = this.failAttempts[request.recipientId];
    const failed = (scoped ?? global)?.includes(request.attempt) ?? false;
    if (failed) {
      return { outcome: "failed", errorCode: this.errorCode, retryable: true };
    }
    return { outcome: "delivered", receiptId: `rcpt-${request.rescueId}-${request.recipientId}-${request.attempt}` };
  }
}

/** 急救调度渠道固定为语音呼叫。 */
export const EMERGENCY_CHANNEL: Channel = "voice";
