import type { AckResponseData } from "../protocol/messages";
import type { TimerHandle, Timers } from "../util/timers";

interface PendingAck {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: TimerHandle;
}

/** A secondary's `emitWithAck` calls that are waiting for the primary to answer. */
export class AckTracker {
  private readonly pending = new Map<string, PendingAck>();

  constructor(
    private readonly timeoutMs: number,
    private readonly timers: Timers,
    private readonly newId: () => string,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  /**
   * Registers a new ack, then calls `send` with its id. Resolves or rejects
   * when {@link settle} receives the answer, and rejects on timeout or if
   * `send` throws.
   */
  track(send: (id: string) => void): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.newId();
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("emitWithAck timed out waiting for primary response"));
      }, this.timeoutMs);

      // Registered before posting, so a primary that answers synchronously is
      // never missed.
      this.pending.set(id, { resolve, reject, timer });
      try {
        send(id);
      }
      catch (err) {
        this.timers.clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Answers the ack the response names. A response for an unknown id is ignored. */
  settle(data: AckResponseData): void {
    const pending = this.pending.get(data.id);
    if (!pending) {
      return;
    }
    this.pending.delete(data.id);
    this.timers.clearTimeout(pending.timer);
    if (typeof data.error === "string" && data.error.length > 0) {
      pending.reject(new Error(data.error));
    }
    else {
      pending.resolve(data.response);
    }
  }

  /** Fails every pending ack, as when they can never be answered. */
  rejectAll(reason: Error): void {
    this.pending.forEach((pending) => {
      this.timers.clearTimeout(pending.timer);
      pending.reject(reason);
    });
    this.pending.clear();
  }
}

/**
 * Primary side of a relayed `emitWithAck`: makes the call, then answers with
 * the server's response or the error message.
 */
export function forwardAck(
  call: () => Promise<unknown>,
  id: string,
  respond: (data: AckResponseData) => void,
): void {
  void (async () => {
    try {
      respond({ id, response: await call() });
    }
    catch (err) {
      respond({ id, response: undefined, error: err instanceof Error ? err.message : String(err) });
    }
  })();
}
