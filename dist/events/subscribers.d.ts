/** A set of subscribers, each added once and removed by the function `add` returns. */
export declare class SubscriberSet<A extends any[]> {
    private readonly subscribers;
    /** @returns an unsubscribe function. */
    add(subscriber: (...args: A) => void): () => void;
    /**
     * Calls every subscriber; one that throws goes to `onError`, and the rest
     * still run. The set is iterated live, as `onPrimaryCheck` always has been:
     * a subscriber added during the round is called in it, and one removed
     * before its turn is not.
     */
    notify(args: A, onError: (error: unknown) => void): void;
    get size(): number;
    clear(): void;
}
/** Subscribers keyed by name. A name's entry is dropped once its last subscriber leaves. */
export declare class KeyedSubscribers<T> {
    private readonly byKey;
    /** @returns an unsubscribe function; calling it twice is harmless. */
    subscribe(key: string, subscriber: (value: T) => void): () => void;
    /** Calls every subscriber for `key`; one that throws goes to `onError`, and the rest still run. */
    publish(key: string, value: T, onError: (error: unknown) => void): void;
    /** How many keys have subscribers. */
    get size(): number;
    clear(): void;
}
