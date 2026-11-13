import type { ClaimData, OutgoingMessage, PrimaryAliveData, TabIdData } from "../protocol/messages";
import type { Logger } from "../util/log";
import { type Timers } from "../util/timers";
import { type PageTarget } from "./page-lifecycle";
export interface PrimacyConfig {
    tabId: string;
    electionTimeout: number;
    electionJitter: number;
    heartbeatInterval: number;
    heartbeatTimeout: number;
}
/** What primacy needs from the tab: the socket that comes with the role. */
export interface PrimacyHost {
    /** Opens and wires the socket. Called once this tab has become primary. */
    openSocket(): void;
    /**
     * Stops relaying the socket's Manager events. The first of the two steps
     * that give the socket up; the page listeners come off between them.
     */
    detachSocket(): void;
    /** Closes and discards the socket. Called while this tab is still primary. */
    releaseSocket(): void;
    hasSocket(): boolean;
}
export interface PrimacyDeps {
    timers: Timers;
    /** A number in [0, 1), for the election jitter. */
    random: () => number;
    page: () => PageTarget | undefined;
}
/**
 * Decides whether this tab is the primary, and keeps that decision consistent
 * across the channel: elections, forced promotion, epochs, duplicate-primary
 * resolution, the heartbeat and the primary's departure.
 *
 * Each promotion takes an **epoch** above every epoch seen. Two live primaries
 * resolve by higher epoch, then by higher `tabId` within an epoch.
 */
export declare class Primacy {
    private readonly config;
    private readonly host;
    private readonly post;
    private readonly deps;
    private readonly log;
    isPrimary: boolean;
    /** This tab's primacy epoch; 0 while it is not the primary. */
    private epoch;
    /** Highest epoch seen from any tab, so a promotion can outrank every peer. */
    private highestSeenEpoch;
    /** The primary has announced its departure and is on its way out. */
    private leaving;
    private closed;
    private initPromise;
    private readonly election;
    private readonly electionWaiters;
    private readonly force;
    private readonly forceWaiters;
    private readonly heartbeat;
    private readonly monitor;
    private readonly page;
    constructor(config: PrimacyConfig, host: PrimacyHost, post: (message: OutgoingMessage) => void, deps: PrimacyDeps, log: Logger);
    private get tabId();
    /**
     * Whether this tab answers as the primary. A primary that has announced its
     * departure must stay quiet, or it answers the very election its own
     * PRIMARY_LEAVING triggered.
     */
    get serving(): boolean;
    /** This tab's claim to primacy, as heartbeats and claims carry it. */
    claim(): ClaimData;
    initialize(): Promise<void>;
    /**
     * Demands primacy; see `SocketIOProxy.forcePrimary`. The caller rejects the
     * call on a closed proxy.
     */
    forcePrimary(): Promise<void>;
    /** @param adopt copies the answering primary's connection state into this tab. */
    onPrimaryAlive(data: PrimaryAliveData, adopt: () => void): void;
    onHeartbeat(data: ClaimData): void;
    onClaim(data: ClaimData): void;
    onYield(data: TabIdData): void;
    onDemand(data: TabIdData): void;
    onStoodDown(data: TabIdData): void;
    onLeaving(data: TabIdData): void;
    /** Tells the other tabs this primary is going, so they re-elect at once. */
    announceDeparture: () => void;
    /**
     * Stops every timer, releases everyone waiting on an election or a demand,
     * and gives up the socket. Call {@link announceDeparture} first, while the
     * channel can still carry it.
     */
    close(): void;
    /**
     * Broadcasts a PRIMARY_CHECK and resolves once the role is settled: as a
     * secondary if a primary answers, as the primary otherwise.
     */
    private startElection;
    private settleElection;
    private completeForcedPromotion;
    private becomePrimary;
    /** Undoes {@link becomePrimary}. Listeners live in the proxy, so demotion does not lose them. */
    private demote;
    /** Starts watching the primary's heartbeat, unless the proxy is closed. */
    private watchPrimary;
    /**
     * Another tab is acting as primary: it counts as heard from, and a pending
     * election is moot.
     *
     * @param overridesDemand whether that also abandons an election started by
     *   this tab's own `forcePrimary()`.
     */
    private followPeerPrimary;
    /** Tracks the highest primacy epoch seen, so a promotion can outrank it. */
    private observeEpoch;
    /** Another tab claims primacy while this one holds it. */
    private contest;
    /**
     * Deterministic tie-break between two live primaries.
     *
     * The more recently elected primary wins: a tab promoted at a higher epoch
     * outranks one at a lower epoch, which is what lets `forcePrimary()` survive
     * a stale peer that happens to hold a higher tabId. Within one epoch — two
     * tabs that elected themselves in the same instant — the higher tabId wins.
     */
    private resolveDuplicatePrimary;
    /**
     * The page came back — a cancelled navigation, or a restore from the back /
     * forward cache. Undo the departure so the tab rejoins the channel.
     */
    private handlePageShow;
}
