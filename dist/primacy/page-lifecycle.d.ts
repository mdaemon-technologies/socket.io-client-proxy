/** The part of `window` the page-lifecycle listeners need. */
export interface PageTarget {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
}
/** The page, or `undefined` outside a browser. */
export declare const browserPage: () => PageTarget | undefined;
/**
 * Tells the primary when its page is going away, and when it comes back.
 *
 * `beforeunload` does not fire reliably on mobile or under the back/forward
 * cache, so `pagehide` is watched too. `pageshow` covers a cancelled
 * navigation or a restore from that cache.
 */
export declare class PageLifecycle {
    private readonly page;
    private readonly listeners;
    constructor(page: () => PageTarget | undefined, onLeave: () => void, onReturn: () => void);
    attach(): void;
    detach(): void;
}
