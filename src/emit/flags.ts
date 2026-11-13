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

const NONE: Flags = { volatile: false, timeout: null, notifyPeers: false };

/** The flags waiting for the next emission. */
export class EmitFlags {
  private next: Flags = { ...NONE };

  volatile(): void {
    this.next.volatile = true;
  }

  timeout(ms: number): void {
    this.next.timeout = ms;
  }

  peers(): void {
    this.next.notifyPeers = true;
  }

  /**
   * Returns the flags and clears them. Call it before validating anything, so
   * a rejected emission cannot leave a stale flag to be applied to the next one.
   */
  take(): Flags {
    const flags = this.next;
    this.next = { ...NONE };
    return flags;
  }
}

/**
 * The `volatile` / `timeout` flags for the wire, present only when set — a key
 * present with an undefined value survives structured cloning and would fail
 * schema validation.
 */
export function encodeFlags(flags: Flags): { volatile?: true; timeout?: number } {
  const encoded: { volatile?: true; timeout?: number } = {};
  if (flags.volatile) {
    encoded.volatile = true;
  }
  if (flags.timeout !== null) {
    encoded.timeout = flags.timeout;
  }
  return encoded;
}

/**
 * Applies the per-emission `timeout`/`volatile` flags. Values arriving over
 * the channel are untrusted, so the timeout is range-checked here rather
 * than in a schema (the validator cannot express an optional property).
 */
export function applyFlags(socket: Socket, flags: FlagInput): Socket {
  let target = socket;
  const { timeout, volatile } = flags;
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0) {
    target = target.timeout(timeout) as unknown as Socket;
  }
  if (volatile === true) {
    target = target.volatile as unknown as Socket;
  }
  return target;
}
