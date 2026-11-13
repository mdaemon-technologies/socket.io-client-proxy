import type { Logger } from "../util/log";
export type Listener = (...args: any[]) => void;
/**
 * This tab's own event listeners, and the `proxy_error` event that reports the
 * proxy's internal errors to them.
 *
 * Listeners always live here, never on the socket, so they survive promotion
 * and demotion: a primary demoted mid-session keeps every listener it was
 * given, and one promoted later fires the ones registered before.
 */
export declare class LocalEmitter {
    private readonly log;
    private readonly listeners;
    constructor(log: Logger);
    on(event: string, callback: Listener): void;
    once(event: string, callback: Listener): void;
    /** Removes one callback, or every callback for `event` when none is given. */
    off(event: string, callback?: Listener): void;
    /** Calls every listener for `event`. One that throws is reported, and the rest still run. */
    emit(event: string, ...args: unknown[]): void;
    /** The callbacks registered for `event`. */
    listenerCount(event: string): number;
    /** How many events have listeners. */
    get size(): number;
    clear(): void;
    /**
     * Reports an internal error to `proxy_error` listeners, as `(error, context)`,
     * without letting it escape into the BroadcastChannel callback, where nothing
     * could catch it.
     */
    reportError: (context: string, error: unknown) => void;
}
