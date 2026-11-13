export type TimerHandle = ReturnType<typeof setTimeout>;

/** The clock and timer functions the proxy runs on, so tests can supply their own. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  now(): number;
}

/**
 * The real timers. Each call looks the global up at call time rather than
 * capturing it here, so timers installed after this module loads (fake timers
 * in a test, say) are the ones used.
 */
export const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
  now: () => Date.now(),
};

/** A one-shot timer that knows whether it is still pending. */
export class Timeout {
  private handle: TimerHandle | null = null;

  constructor(private readonly timers: Timers) {}

  get pending(): boolean {
    return this.handle !== null;
  }

  /** Starts the timer, replacing any that is still pending. */
  start(ms: number, callback: () => void): void {
    this.clear();
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      callback();
    }, ms);
  }

  clear(): void {
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
  }
}

/** A repeating timer that knows whether it is running. */
export class Interval {
  private handle: TimerHandle | null = null;

  constructor(private readonly timers: Timers) {}

  get running(): boolean {
    return this.handle !== null;
  }

  /** Starts the timer, replacing any that is already running. */
  start(ms: number, callback: () => void): void {
    this.stop();
    this.handle = this.timers.setInterval(callback, ms);
  }

  stop(): void {
    if (this.handle !== null) {
      this.timers.clearInterval(this.handle);
      this.handle = null;
    }
  }
}
