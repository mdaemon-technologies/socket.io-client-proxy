/** The part of `window` the page-lifecycle listeners need. */
export interface PageTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The page, or `undefined` outside a browser. */
export const browserPage = (): PageTarget | undefined =>
  (typeof window === "undefined" ? undefined : window);

/**
 * Tells the primary when its page is going away, and when it comes back.
 *
 * `beforeunload` does not fire reliably on mobile or under the back/forward
 * cache, so `pagehide` is watched too. `pageshow` covers a cancelled
 * navigation or a restore from that cache.
 */
export class PageLifecycle {
  private readonly listeners: [string, () => void][];

  constructor(
    private readonly page: () => PageTarget | undefined,
    onLeave: () => void,
    onReturn: () => void,
  ) {
    this.listeners = [
      ["beforeunload", onLeave],
      ["pagehide", onLeave],
      ["pageshow", onReturn],
    ];
  }

  attach(): void {
    const target = this.page();
    this.listeners.forEach(([type, listener]) => target?.addEventListener(type, listener));
  }

  detach(): void {
    const target = this.page();
    this.listeners.forEach(([type, listener]) => target?.removeEventListener(type, listener));
  }
}
