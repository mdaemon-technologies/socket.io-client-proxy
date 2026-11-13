import type { Logger } from "../util/log";
import { type MessageHandlers, type OutgoingMessage } from "./messages";
/** The part of `BroadcastChannel` the proxy uses. */
export interface ChannelLike {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
}
export type ChannelFactory = (name: string) => ChannelLike;
export type ErrorReporter = (context: string, error: unknown) => void;
/**
 * The proxy's BroadcastChannel, wrapped: tags outgoing messages, validates
 * incoming ones and routes each to its handler.
 *
 * Two ways to post, kept distinct on purpose:
 * - {@link post} lets failures reach the caller. It is for the calls a user
 *   drives directly, where a payload that cannot be structured-cloned is worth
 *   surfacing at the call site.
 * - {@link safePost} is for traffic nobody is waiting on — protocol messages,
 *   heartbeats, state broadcasts. Those run inside timers, socket.io's dispatch
 *   loop and the BroadcastChannel callback, where a throw would take down the
 *   tab or surface as an unhandled rejection, so failures are reported instead.
 */
export declare class ChannelTransport {
    readonly name: string;
    private readonly log;
    private readonly reportError;
    readonly token: string;
    private readonly channel;
    private isClosed;
    constructor(name: string, createChannel: ChannelFactory, log: Logger, reportError: ErrorReporter);
    get closed(): boolean;
    /**
     * Installs the one message handler, for good. Elections are handled by this
     * same handler so no message is ever dropped mid-election.
     */
    listen(handlers: MessageHandlers): void;
    post: (message: OutgoingMessage) => void;
    safePost: (message: OutgoingMessage, context?: string) => void;
    /** Stops posting and listening. Idempotent. */
    close(): void;
    /** A malformed or hostile message must never throw out of the channel callback. */
    private receive;
}
