/**
 * 时钟抽象。生产环境使用系统时钟；演示与回放使用可控时钟，
 * 以便按事件发生时刻（capturedAt / receivedAt）确定性地驱动整条救援链。
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class ControlledClock implements Clock {
  private current: number;

  constructor(start: Date | number | string = Date.now()) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | number | string): void {
    this.current = new Date(at).getTime();
  }

  advanceMs(ms: number): Date {
    this.current += ms;
    return this.now();
  }

  advanceSeconds(seconds: number): Date {
    return this.advanceMs(seconds * 1000);
  }
}
