import { Interval, type Timers } from "../util/timers";

/** The primary's heartbeat: `beat` every `intervalMs` while running. */
export class HeartbeatSender {
  private readonly interval: Interval;

  constructor(timers: Timers, private readonly intervalMs: number, private readonly beat: () => void) {
    this.interval = new Interval(timers);
  }

  get running(): boolean {
    return this.interval.running;
  }

  start(): void {
    this.interval.start(this.intervalMs, this.beat);
  }

  stop(): void {
    this.interval.stop();
  }
}

/**
 * A secondary's watch on the primary's heartbeat. Checks every `intervalMs`
 * and calls `onLost` once nothing has been heard for longer than `timeoutMs`.
 * Anything that proves a primary is alive counts — call {@link touch}.
 */
export class HeartbeatMonitor {
  private readonly interval: Interval;
  private lastHeard: number;

  constructor(
    private readonly timers: Timers,
    private readonly intervalMs: number,
    private readonly timeoutMs: number,
    private readonly onLost: () => void,
  ) {
    this.interval = new Interval(timers);
    this.lastHeard = timers.now();
  }

  get running(): boolean {
    return this.interval.running;
  }

  /** Restarts the watch, counting from now. */
  start(): void {
    this.lastHeard = this.timers.now();
    this.interval.start(this.intervalMs, () => {
      if (this.timers.now() - this.lastHeard > this.timeoutMs) {
        this.onLost();
      }
    });
  }

  stop(): void {
    this.interval.stop();
  }

  /** A primary was heard from just now. */
  touch(): void {
    this.lastHeard = this.timers.now();
  }
}
