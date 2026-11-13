import { invokeAll } from "../util/callbacks";

/** A set of subscribers, each added once and removed by the function `add` returns. */
export class SubscriberSet<A extends any[]> {
  private readonly subscribers = new Set<(...args: A) => void>();

  /** @returns an unsubscribe function. */
  add(subscriber: (...args: A) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Calls every subscriber; one that throws goes to `onError`, and the rest
   * still run. The set is iterated live, as `onPrimaryCheck` always has been:
   * a subscriber added during the round is called in it, and one removed
   * before its turn is not.
   */
  notify(args: A, onError: (error: unknown) => void): void {
    this.subscribers.forEach((subscriber) => {
      try {
        subscriber(...args);
      }
      catch (err) {
        onError(err);
      }
    });
  }

  get size(): number {
    return this.subscribers.size;
  }

  clear(): void {
    this.subscribers.clear();
  }
}

/** Subscribers keyed by name. A name's entry is dropped once its last subscriber leaves. */
export class KeyedSubscribers<T> {
  private readonly byKey = new Map<string, Set<(value: T) => void>>();

  /** @returns an unsubscribe function; calling it twice is harmless. */
  subscribe(key: string, subscriber: (value: T) => void): () => void {
    let subscribers = this.byKey.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.byKey.set(key, subscribers);
    }
    subscribers.add(subscriber);

    return () => {
      const current = this.byKey.get(key);
      if (!current) {
        return;
      }
      current.delete(subscriber);
      if (current.size === 0) {
        this.byKey.delete(key);
      }
    };
  }

  /** Calls every subscriber for `key`; one that throws goes to `onError`, and the rest still run. */
  publish(key: string, value: T, onError: (error: unknown) => void): void {
    const subscribers = this.byKey.get(key);
    if (subscribers) {
      invokeAll(subscribers, [value], onError);
    }
  }

  /** How many keys have subscribers. */
  get size(): number {
    return this.byKey.size;
  }

  clear(): void {
    this.byKey.clear();
  }
}
