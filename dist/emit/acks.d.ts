import type { AckResponseData } from "../protocol/messages";
import type { Timers } from "../util/timers";
/** A secondary's `emitWithAck` calls that are waiting for the primary to answer. */
export declare class AckTracker {
    private readonly timeoutMs;
    private readonly timers;
    private readonly newId;
    private readonly pending;
    constructor(timeoutMs: number, timers: Timers, newId: () => string);
    get size(): number;
    /**
     * Registers a new ack, then calls `send` with its id. Resolves or rejects
     * when {@link settle} receives the answer, and rejects on timeout or if
     * `send` throws.
     */
    track(send: (id: string) => void): Promise<any>;
    /** Answers the ack the response names. A response for an unknown id is ignored. */
    settle(data: AckResponseData): void;
    /** Fails every pending ack, as when they can never be answered. */
    rejectAll(reason: Error): void;
}
/**
 * Primary side of a relayed `emitWithAck`: makes the call, then answers with
 * the server's response or the error message.
 */
export declare function forwardAck(call: () => Promise<unknown>, id: string, respond: (data: AckResponseData) => void): void;
