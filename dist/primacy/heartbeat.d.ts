import { type Timers } from "../util/timers";
/** The primary's heartbeat: `beat` every `intervalMs` while running. */
export declare class HeartbeatSender {
    private readonly intervalMs;
    private readonly beat;
    private readonly interval;
    constructor(timers: Timers, intervalMs: number, beat: () => void);
    get running(): boolean;
    start(): void;
    stop(): void;
}
/**
 * A secondary's watch on the primary's heartbeat. Checks every `intervalMs`
 * and calls `onLost` once nothing has been heard for longer than `timeoutMs`.
 * Anything that proves a primary is alive counts — call {@link touch}.
 */
export declare class HeartbeatMonitor {
    private readonly timers;
    private readonly intervalMs;
    private readonly timeoutMs;
    private readonly onLost;
    private readonly interval;
    private lastHeard;
    constructor(timers: Timers, intervalMs: number, timeoutMs: number, onLost: () => void);
    get running(): boolean;
    /** Restarts the watch, counting from now. */
    start(): void;
    stop(): void;
    /** A primary was heard from just now. */
    touch(): void;
}
