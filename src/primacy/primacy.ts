import type { ClaimData, OutgoingMessage, PrimaryAliveData, TabIdData } from "../protocol/messages";
import { Waiters } from "../util/callbacks";
import type { Logger } from "../util/log";
import { Timeout, type Timers } from "../util/timers";
import { HeartbeatMonitor, HeartbeatSender } from "./heartbeat";
import { PageLifecycle, type PageTarget } from "./page-lifecycle";

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

/** A finite epoch, or 0 for anything else a peer sent. */
function toEpoch(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Decides whether this tab is the primary, and keeps that decision consistent
 * across the channel: elections, forced promotion, epochs, duplicate-primary
 * resolution, the heartbeat and the primary's departure.
 *
 * Each promotion takes an **epoch** above every epoch seen. Two live primaries
 * resolve by higher epoch, then by higher `tabId` within an epoch.
 */
export class Primacy {
  isPrimary = false;
  /** This tab's primacy epoch; 0 while it is not the primary. */
  private epoch = 0;
  /** Highest epoch seen from any tab, so a promotion can outrank every peer. */
  private highestSeenEpoch = 0;
  /** The primary has announced its departure and is on its way out. */
  private leaving = false;
  private closed = false;
  private initPromise: Promise<void> | null = null;

  private readonly election: Timeout;
  private readonly electionWaiters = new Waiters();
  private readonly force: Timeout;
  private readonly forceWaiters = new Waiters();
  private readonly heartbeat: HeartbeatSender;
  private readonly monitor: HeartbeatMonitor;
  private readonly page: PageLifecycle;

  constructor(
    private readonly config: PrimacyConfig,
    private readonly host: PrimacyHost,
    private readonly post: (message: OutgoingMessage) => void,
    private readonly deps: PrimacyDeps,
    private readonly log: Logger,
  ) {
    this.election = new Timeout(deps.timers);
    this.force = new Timeout(deps.timers);
    this.heartbeat = new HeartbeatSender(deps.timers, config.heartbeatInterval, () => {
      this.post({ type: "HEARTBEAT", data: this.claim() });
    });
    this.monitor = new HeartbeatMonitor(
      deps.timers,
      config.heartbeatInterval,
      config.heartbeatTimeout,
      () => {
        this.log("Primary heartbeat lost, initiating re-election");
        this.monitor.stop();
        void this.startElection();
      },
    );
    this.page = new PageLifecycle(deps.page, this.announceDeparture, this.handlePageShow);
  }

  private get tabId(): string {
    return this.config.tabId;
  }

  /**
   * Whether this tab answers as the primary. A primary that has announced its
   * departure must stay quiet, or it answers the very election its own
   * PRIMARY_LEAVING triggered.
   */
  get serving(): boolean {
    return this.isPrimary && !this.leaving;
  }

  /** This tab's claim to primacy, as heartbeats and claims carry it. */
  claim(): ClaimData {
    return { tabId: this.tabId, epoch: this.epoch };
  }

  initialize(): Promise<void> {
    // Repeat calls must not stack a second election or a second set of timers.
    if (!this.initPromise) {
      this.initPromise = this.startElection();
    }
    return this.initPromise;
  }

  /**
   * Demands primacy; see `SocketIOProxy.forcePrimary`. The caller rejects the
   * call on a closed proxy.
   */
  forcePrimary(): Promise<void> {
    if (this.serving) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.forceWaiters.add(resolve);

      if (this.force.pending) {
        // A demand is already in flight; join it rather than issuing another.
        return;
      }

      // A later initialize() must not start a competing election.
      if (!this.initPromise) {
        this.initPromise = Promise.resolve();
      }

      this.monitor.stop();
      this.force.start(this.config.electionTimeout, () => {
        // Nobody answered, so there is no primary to wait for.
        this.log("No primary answered the demand, promoting");
        this.completeForcedPromotion();
      });

      this.log("Demanding primary, tabId:", this.tabId);
      this.post({ type: "PRIMARY_DEMAND", data: { tabId: this.tabId } });
    });
  }

  // --- messages ---------------------------------------------------------------

  /** @param adopt copies the answering primary's connection state into this tab. */
  onPrimaryAlive(data: PrimaryAliveData, adopt: () => void): void {
    this.observeEpoch(data.epoch);
    if (this.isPrimary && !this.election.pending) {
      // Two primaries are alive. Reconcile, but do not adopt the other
      // tab's state — if this one wins the tie-break it would be left
      // reporting a connection it does not own.
      this.contest(data);
      return;
    }
    // An existing primary answered. Adopt its state and stand down.
    //
    // Deliberately silent: this lands during initialize(), before the
    // caller has had a chance to subscribe, and the state is readable from
    // the getters the moment initialize() resolves.
    adopt();
    this.followPeerPrimary(true);
  }

  onHeartbeat(data: ClaimData): void {
    this.observeEpoch(data.epoch);
    if (this.isPrimary) {
      // Two primaries are alive at once. Reconcile immediately rather than
      // waiting for the next election.
      this.contest(data);
    }
    else {
      this.followPeerPrimary(true);
    }
  }

  onClaim(data: ClaimData): void {
    this.observeEpoch(data.epoch);
    if (data.tabId === this.tabId) {
      return;
    }
    if (this.isPrimary) {
      this.contest(data);
    }
    else {
      // Someone else won the race; abandon our own pending election. A
      // forced promotion is deliberate and outranks the claim, so it is
      // left to run.
      this.followPeerPrimary(false);
    }
  }

  onYield(data: TabIdData): void {
    // Targeted at exactly one tab, so an unrelated primary is never demoted.
    if (this.isPrimary && data.tabId === this.tabId) {
      this.log("Received PRIMARY_YIELD, demoting");
      this.demote();
    }
  }

  onDemand(data: TabIdData): void {
    // Another tab is claiming the socket deliberately. Stand down without
    // arguing — a demand outranks the tabId tie-break by design — and tell
    // it the socket is free.
    if (data.tabId !== this.tabId && this.isPrimary) {
      this.log("Primary demanded by", data.tabId, "- standing down");
      this.demote();
      this.post({ type: "PRIMARY_STOOD_DOWN", data: { tabId: data.tabId } });
    }
  }

  onStoodDown(data: TabIdData): void {
    if (data.tabId === this.tabId && this.force.pending) {
      this.completeForcedPromotion();
    }
  }

  onLeaving(data: TabIdData): void {
    // The primary is going away. Re-elect now instead of waiting out
    // heartbeatTimeout.
    if (!this.isPrimary && data.tabId !== this.tabId) {
      this.log("Primary is leaving, starting election");
      this.monitor.stop();
      void this.startElection();
    }
  }

  // --- departure and teardown ---------------------------------------------------

  /** Tells the other tabs this primary is going, so they re-elect at once. */
  announceDeparture = (): void => {
    if (!this.isPrimary || this.leaving || this.closed) {
      return;
    }
    // Marked before the broadcast so the ensuing election is not answered by
    // the tab that is on its way out.
    this.leaving = true;
    this.heartbeat.stop();
    this.post({ type: "PRIMARY_LEAVING", data: { tabId: this.tabId } });
  };

  /**
   * Stops every timer, releases everyone waiting on an election or a demand,
   * and gives up the socket. Call {@link announceDeparture} first, while the
   * channel can still carry it.
   */
  close(): void {
    this.closed = true;
    this.heartbeat.stop();
    this.monitor.stop();
    this.page.detach();
    this.election.clear();
    this.force.clear();
    this.electionWaiters.resolveAll();
    this.forceWaiters.resolveAll();

    this.host.detachSocket();
    this.host.releaseSocket();
    this.isPrimary = false;
    this.epoch = 0;
  }

  // --- internals ----------------------------------------------------------------

  /**
   * Broadcasts a PRIMARY_CHECK and resolves once the role is settled: as a
   * secondary if a primary answers, as the primary otherwise.
   */
  private startElection(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.electionWaiters.add(resolve);

      if (this.election.pending) {
        // An election is already running; join it rather than starting another.
        return;
      }

      // Jitter staggers simultaneous elections so one tab wins outright.
      const { electionTimeout, electionJitter } = this.config;
      const delay = electionTimeout + Math.floor(this.deps.random() * (electionJitter + 1));
      this.election.start(delay, () => this.settleElection(true));
      // A check that cannot be sent is not fatal: the timer still fires and
      // this tab promotes itself, which is the right fallback.
      this.post({ type: "PRIMARY_CHECK" });
    });
  }

  private settleElection(promote: boolean, epoch?: number): void {
    this.election.clear();

    if (promote) {
      this.becomePrimary(epoch);
    }
    else {
      this.isPrimary = false;
      this.watchPrimary();
    }

    this.electionWaiters.resolveAll();
  }

  private completeForcedPromotion(): void {
    this.force.clear();
    // settleElection also clears any ordinary election that was in flight and
    // resolves the callers waiting on it.
    this.settleElection(true, this.highestSeenEpoch + 1);
    this.forceWaiters.resolveAll();
  }

  private becomePrimary(epoch?: number): void {
    if (this.isPrimary || this.closed) {
      return;
    }

    this.isPrimary = true;
    this.leaving = false;
    // A promotion always takes an epoch above everything seen so far, so the
    // newest primary outranks any stale one still holding a socket.
    this.epoch = Math.max(epoch ?? 0, this.highestSeenEpoch + 1);
    this.highestSeenEpoch = this.epoch;

    this.host.openSocket();

    this.page.attach();
    this.heartbeat.start();
    this.monitor.stop();
    this.post({ type: "PRIMARY_CLAIM", data: this.claim() });
    this.log("Became primary, tabId:", this.tabId, "epoch:", this.epoch);
  }

  /** Undoes {@link becomePrimary}. Listeners live in the proxy, so demotion does not lose them. */
  private demote(): void {
    this.log("Demoting from primary");
    this.heartbeat.stop();
    this.host.detachSocket();
    this.page.detach();
    this.host.releaseSocket();
    this.isPrimary = false;
    this.leaving = false;
    this.epoch = 0;
    this.watchPrimary();
  }

  /** Starts watching the primary's heartbeat, unless the proxy is closed. */
  private watchPrimary(): void {
    if (this.closed) {
      this.monitor.stop();
      return;
    }
    this.monitor.start();
  }

  /**
   * Another tab is acting as primary: it counts as heard from, and a pending
   * election is moot.
   *
   * @param overridesDemand whether that also abandons an election started by
   *   this tab's own `forcePrimary()`.
   */
  private followPeerPrimary(overridesDemand: boolean): void {
    this.monitor.touch();
    if (this.election.pending && (overridesDemand || !this.force.pending)) {
      this.settleElection(false);
    }
  }

  /** Tracks the highest primacy epoch seen, so a promotion can outrank it. */
  private observeEpoch(epoch: unknown): void {
    const value = toEpoch(epoch);
    if (value > this.highestSeenEpoch) {
      this.highestSeenEpoch = value;
    }
  }

  /** Another tab claims primacy while this one holds it. */
  private contest(other: ClaimData): void {
    if (other.tabId !== this.tabId) {
      this.resolveDuplicatePrimary(other.tabId, other.epoch);
    }
  }

  /**
   * Deterministic tie-break between two live primaries.
   *
   * The more recently elected primary wins: a tab promoted at a higher epoch
   * outranks one at a lower epoch, which is what lets `forcePrimary()` survive
   * a stale peer that happens to hold a higher tabId. Within one epoch — two
   * tabs that elected themselves in the same instant — the higher tabId wins.
   */
  private resolveDuplicatePrimary(otherTabId: string, otherEpoch: unknown): void {
    const theirs = toEpoch(otherEpoch);
    const outranked = theirs > this.epoch || (theirs === this.epoch && otherTabId > this.tabId);

    if (this.leaving || outranked) {
      this.log("Duplicate primary detected, yielding to", otherTabId);
      this.demote();
    }
    else {
      this.post({ type: "PRIMARY_YIELD", data: { tabId: otherTabId } });
    }
  }

  /**
   * The page came back — a cancelled navigation, or a restore from the back /
   * forward cache. Undo the departure so the tab rejoins the channel.
   */
  private handlePageShow = (): void => {
    if (this.closed || !this.leaving) {
      return;
    }
    this.leaving = false;
    if (this.isPrimary && this.host.hasSocket()) {
      this.heartbeat.start();
      this.post({ type: "PRIMARY_CLAIM", data: this.claim() });
    }
    else {
      this.watchPrimary();
    }
  };
}
