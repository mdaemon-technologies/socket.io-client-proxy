/**
 * Calls every callback with `args`, isolating each one: a callback that throws
 * is handed to `onError` and the rest still run.
 *
 * The callbacks are copied first, so one that unsubscribes (or subscribes)
 * during the call cannot make a peer be skipped or called twice.
 */
export function invokeAll<A extends any[]>(
  callbacks: Iterable<(...args: A) => void>,
  args: A,
  onError: (error: unknown) => void,
): void {
  Array.from(callbacks).forEach((callback) => {
    try {
      callback(...args);
    }
    catch (err) {
      onError(err);
    }
  });
}

/** Callers parked on one outcome, released together. */
export class Waiters {
  private resolvers: (() => void)[] = [];

  add(resolve: () => void): void {
    this.resolvers.push(resolve);
  }

  /** Releases everyone waiting so far; later arrivals wait for the next round. */
  resolveAll(): void {
    const resolvers = this.resolvers;
    this.resolvers = [];
    resolvers.forEach((resolve) => resolve());
  }
}
