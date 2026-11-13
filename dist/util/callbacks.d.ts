/**
 * Calls every callback with `args`, isolating each one: a callback that throws
 * is handed to `onError` and the rest still run.
 *
 * The callbacks are copied first, so one that unsubscribes (or subscribes)
 * during the call cannot make a peer be skipped or called twice.
 */
export declare function invokeAll<A extends any[]>(callbacks: Iterable<(...args: A) => void>, args: A, onError: (error: unknown) => void): void;
/** Callers parked on one outcome, released together. */
export declare class Waiters {
    private resolvers;
    add(resolve: () => void): void;
    /** Releases everyone waiting so far; later arrivals wait for the next round. */
    resolveAll(): void;
}
