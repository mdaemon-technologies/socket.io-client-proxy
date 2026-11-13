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
export declare const realTimers: Timers;
/** A one-shot timer that knows whether it is still pending. */
export declare class Timeout {
    private readonly timers;
    private handle;
    constructor(timers: Timers);
    get pending(): boolean;
    /** Starts the timer, replacing any that is still pending. */
    start(ms: number, callback: () => void): void;
    clear(): void;
}
/** A repeating timer that knows whether it is running. */
export declare class Interval {
    private readonly timers;
    private handle;
    constructor(timers: Timers);
    get running(): boolean;
    /** Starts the timer, replacing any that is already running. */
    start(ms: number, callback: () => void): void;
    stop(): void;
}
