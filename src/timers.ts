/**
 * 定时器宿主：
 * - 编排器把"下一次动作"（询问超时、联系人确认超时、提供商重试）持久化后交给宿主；
 * - RealTimer 面向进程运行期；VirtualTimer 面向确定性回放与测试；
 * - 重启恢复时，编排器依据持久化的 pending 信息重新注册同一个 token，
 *   token 在状态中生成并保存，因此重启不会重复或丢失动作。
 */
export interface TimerHost {
  now(): string;
  schedule(token: string, fireAt: string, job: () => Promise<void>): void;
  cancel(token: string): void;
}

export class RealTimer implements TimerHost {
  private readonly handles = new Map<string, ReturnType<typeof setTimeout>>();

  now(): string {
    return new Date().toISOString();
  }

  schedule(token: string, fireAt: string, job: () => Promise<void>): void {
    const ms = Math.max(0, Date.parse(fireAt) - Date.now());
    const handle = setTimeout(() => {
      this.handles.delete(token);
      // 定时任务异常只上抛日志，绝不让进程崩溃。
      void job().catch((err) => console.error(`timer ${token} failed`, err));
    }, ms);
    this.handles.set(token, handle);
  }

  cancel(token: string): void {
    const handle = this.handles.get(token);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.handles.delete(token);
    }
  }

  cancelAll(): void {
    for (const token of this.handles.keys()) this.cancel(token);
  }
}

/**
 * 虚拟时钟：时间只在 advanceTo 时前进，到期任务按 fireAt 顺序串行执行，
 * 保证回放结果确定、可断言。
 */
export class VirtualTimer implements TimerHost {
  private current: number;
  private readonly jobs = new Map<string, { at: number; job: () => Promise<void> }>();

  constructor(startAt: string) {
    this.current = Date.parse(startAt);
  }

  now(): string {
    return new Date(this.current).toISOString();
  }

  schedule(token: string, fireAt: string, job: () => Promise<void>): void {
    this.jobs.set(token, { at: Date.parse(fireAt), job });
  }

  cancel(token: string): void {
    this.jobs.delete(token);
  }

  /** 推进到目标时刻并反复执行到期任务（任务可能注册更晚的新任务）。 */
  async advanceTo(targetIso: string): Promise<void> {
    const target = Date.parse(targetIso);
    for (;;) {
      let nextToken: string | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [token, job] of this.jobs) {
        if (job.at <= target && job.at < nextAt) {
          nextAt = job.at;
          nextToken = token;
        }
      }
      if (nextToken === undefined) {
        this.current = Math.max(this.current, target);
        return;
      }
      // 触发时刻即成为当前时间，保证回执/时间戳落在调度点上。
      this.current = Math.max(this.current, nextAt);
      const job = this.jobs.get(nextToken);
      this.jobs.delete(nextToken);
      await job?.job();
    }
  }
}
