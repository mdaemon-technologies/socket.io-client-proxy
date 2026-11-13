import { PROXY_ERROR_EVENT } from "../protocol/constants";
import { invokeAll } from "../util/callbacks";
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
export class LocalEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  constructor(private readonly log: Logger) {}

  on(event: string, callback: Listener): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.push(callback);
    }
    else {
      this.listeners.set(event, [callback]);
    }
  }

  once(event: string, callback: Listener): void {
    const wrappedCallback = (...args: any[]) => {
      this.off(event, wrappedCallback);
      callback(...args);
    };
    this.on(event, wrappedCallback);
  }

  /** Removes one callback, or every callback for `event` when none is given. */
  off(event: string, callback?: Listener): void {
    if (!callback) {
      this.listeners.delete(event);
      return;
    }
    const callbacks = this.listeners.get(event);
    if (!callbacks) {
      return;
    }
    const index = callbacks.indexOf(callback);
    if (index !== -1) {
      callbacks.splice(index, 1);
    }
    if (callbacks.length === 0) {
      this.listeners.delete(event);
    }
  }

  /** Calls every listener for `event`. One that throws is reported, and the rest still run. */
  emit(event: string, ...args: unknown[]): void {
    const callbacks = this.listeners.get(event);
    if (!callbacks) {
      return;
    }
    invokeAll(callbacks, args, (err) => this.reportError(`dispatching "${event}" to a listener`, err));
  }

  /** The callbacks registered for `event`. */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** How many events have listeners. */
  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }

  /**
   * Reports an internal error to `proxy_error` listeners, as `(error, context)`,
   * without letting it escape into the BroadcastChannel callback, where nothing
   * could catch it.
   */
  reportError = (context: string, error: unknown): void => {
    this.log("Error while", context, error);
    const callbacks = this.listeners.get(PROXY_ERROR_EVENT);
    if (!callbacks || callbacks.length === 0) {
      return;
    }
    const wrapped = error instanceof Error ? error : new Error(String(error));
    invokeAll(callbacks, [wrapped, context], () => {
      /* a failing error handler must not re-enter reportError */
    });
  };
}
