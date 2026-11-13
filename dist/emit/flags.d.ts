import type { Socket } from "socket.io-client";
/** The per-emission flags set by `volatile()`, `timeout()` and `peers()`. */
export interface Flags {
    volatile: boolean;
    timeout: number | null;
    notifyPeers: boolean;
}
/** Flags as they arrive over the channel: untrusted, and possibly absent. */
export interface FlagInput {
    volatile?: unknown;
    timeout?: unknown;
}
/** The flags waiting for the next emission. */
export declare class EmitFlags {
    private next;
    volatile(): void;
    timeout(ms: number): void;
    peers(): void;
    /**
     * Returns the flags and clears them. Call it before validating anything, so
     * a rejected emission cannot leave a stale flag to be applied to the next one.
     */
    take(): Flags;
}
/**
 * The `volatile` / `timeout` flags for the wire, present only when set — a key
 * present with an undefined value survives structured cloning and would fail
 * schema validation.
 */
export declare function encodeFlags(flags: Flags): {
    volatile?: true;
    timeout?: number;
};
/**
 * Applies the per-emission `timeout`/`volatile` flags. Values arriving over
 * the channel are untrusted, so the timeout is range-checked here rather
 * than in a schema (the validator cannot express an optional property).
 */
export declare function applyFlags(socket: Socket, flags: FlagInput): Socket;
