import { ManagerOptions, SocketOptions } from "socket.io-client";
export interface SocketIOProxyOptions extends Partial<ManagerOptions & SocketOptions> {
    /** Log internal state transitions and rejected messages to the console. */
    debug?: boolean;
    /** How often the primary broadcasts a heartbeat, in ms. Default 3000. */
    heartbeatInterval?: number;
    /** How long a secondary waits without a heartbeat before re-electing, in ms. Default 10000. */
    heartbeatTimeout?: number;
    /** How long a secondary waits for an `emitWithAck` response from the primary, in ms. Default 10000. */
    ackTimeout?: number;
    /** How long to wait for an existing primary to answer before self-promoting, in ms. Default 2000. */
    electionTimeout?: number;
    /**
     * Upper bound of the random delay added to `electionTimeout`, in ms. Default 250.
     * Staggers simultaneous elections so one tab wins outright instead of every
     * tab promoting itself at the same instant.
     */
    electionJitter?: number;
    /**
     * Derive the effective BroadcastChannel name from the connection identity
     * (`url` plus `auth`, `query`, `path` and `extraHeaders`) so that tabs
     * authenticated as different principals never share a socket. Default true.
     *
     * Note: a dynamic `auth` *callback* cannot be fingerprinted — only its source
     * is visible — so applications using one must scope `channelId` themselves.
     */
    isolateByAuth?: boolean;
    /**
     * Warn on the console when another tab on the same `channelId` is running a
     * different connection identity *and* describes it with a different set of
     * keys — the signature of one principal configured inconsistently, rather
     * than two genuinely different principals. Default true.
     *
     * Setting it false skips the diagnostics channel entirely.
     */
    warnOnIdentityMismatch?: boolean;
    /**
     * Passed straight through to socket.io, and additionally seeds the channel's
     * **connection intent**: `false` means "do not open the socket until I say
     * so", and that decision survives failover.
     *
     * Intent is channel-wide, not per-tab. Once any tab calls `connect()`, a tab
     * promoted afterwards opens its socket without the consumer being involved;
     * once any tab calls `disconnect()`, a tab promoted afterwards does not.
     * Default true.
     */
    autoConnect?: boolean;
}
/** Snapshot carried by the `connection_state_changed` event. */
export interface ConnectionState {
    /** Whether the primary's socket is connected. */
    connected: boolean;
    /** The socket session id, or `undefined` when there is none. */
    id: string | undefined;
    /** Whether the primary's socket is active (connected or reconnecting). */
    active: boolean;
    /**
     * The channel's connection intent. `false` with `connected: false` means the
     * channel is deliberately offline; `true` with `connected: false` means it
     * wants to be connected and is not — a failure, not a choice.
     */
    wantsConnection: boolean;
}
/** Payload accepted by {@link SocketIOProxy.sendMessageToPrimary}. */
export interface ProxyMessage {
    /** Channel name the primary's `onProxyMessage` subscribers are keyed by. */
    eventName: string;
    /** Arbitrary structured-cloneable payload. */
    message?: any;
}
export default class SocketIOProxy {
    /**
     * Local-only event name carrying internal errors the proxy caught, as
     * `(error, context)`. Exposed as a static rather than a named export so the
     * bundle keeps a single default export for UMD/CommonJS consumers.
     */
    static readonly PROXY_ERROR_EVENT = "proxy_error";
    /** Wire protocol version; tabs on different versions ignore each other. */
    static readonly PROTOCOL_VERSION = 3;
    /**
     * Local-only event name fired on a secondary when it applies a
     * connection-state push from the primary, with a {@link ConnectionState}
     * snapshot. Subscribe instead of polling `connected` / `id` / `active`.
     */
    static readonly CONNECTION_STATE_EVENT = "connection_state_changed";
    private socket;
    private listeners;
    private options;
    private url;
    private channel;
    private channelId;
    private lobby;
    private rawChannelId;
    private identityFingerprint;
    private identityKeyPaths;
    private warnedIdentities;
    private isConnected;
    /**
     * The channel's connection intent — whether the socket is *meant* to be open.
     * Channel-wide rather than per-tab, so that a tab promoted by failover opens
     * a socket the consumer asked for on some other tab, and does not open one
     * the consumer closed there.
     */
    private connectionIntent;
    private primaryCheckSubscribers;
    private messageSubscribers;
    private pendingAcks;
    private token;
    private ackTimeout;
    private debug;
    private tabId;
    private socketId;
    private socketActive;
    private _useVolatile;
    private _timeout;
    private _notifyPeers;
    private heartbeatInterval;
    private heartbeatTimeout;
    private electionTimeout;
    private electionJitter;
    private heartbeatTimer;
    private heartbeatMonitorTimer;
    private electionTimer;
    private electionResolvers;
    private forceTimer;
    private forceResolvers;
    private managerListeners;
    /** This tab's primacy epoch; 0 while it is not the primary. */
    private epoch;
    /** Highest epoch seen from any tab, so a promotion can outrank every peer. */
    private highestSeenEpoch;
    private lastHeartbeat;
    private initPromise;
    private closed;
    private leaving;
    isPrimary: boolean;
    constructor(channelId: string, url: string, options?: SocketIOProxyOptions);
    /**
     * The channel name a given configuration resolves to, without constructing a
     * proxy or opening a channel.
     *
     * Two call sites that are meant to share one socket must produce the same
     * value; asserting that in a test turns a silent runtime split into a build
     * failure.
     */
    static channelNameFor(channelId: string, url: string, options?: SocketIOProxyOptions): string;
    /** The effective BroadcastChannel name, including the connection-identity suffix. */
    get channelName(): string;
    private announceIdentity;
    private postLobby;
    /**
     * Hand-checked rather than schema-validated: this is a diagnostics
     * side-channel, not part of the wire protocol, and anything unrecognised is
     * simply ignored.
     */
    private handleLobbyMessage;
    /**
     * Warns only when the two identities are described by different *key sets*.
     * Matching keys with differing values means two principals, which is the
     * whole point of the isolation and must stay silent.
     */
    private reportIdentityMismatch;
    private validateMessage;
    /**
     * Posts a message, letting failures reach the caller. Used for the paths a
     * user drives directly, where a payload that cannot be structured-cloned is
     * worth surfacing at the call site.
     */
    private postMessage;
    /**
     * Posts a message that nobody is waiting on — protocol traffic, heartbeats,
     * state broadcasts. These run inside timers, socket.io's dispatch loop and
     * the BroadcastChannel callback, where a throw would take down the tab or
     * surface as an unhandled rejection, so failures are reported instead.
     */
    private safePost;
    private log;
    /**
     * Reports an internal error to `proxy_error` listeners without letting it
     * escape into the BroadcastChannel callback, where nothing could catch it.
     */
    private reportError;
    private installMessageHandler;
    private handleMessage;
    /** Tracks the highest primacy epoch seen, so a promotion can outrank it. */
    private observeEpoch;
    /**
     * Deterministic tie-break between two live primaries.
     *
     * The more recently elected primary wins: a tab promoted at a higher epoch
     * outranks one at a lower epoch, which is what lets `forcePrimary()` survive
     * a stale peer that happens to hold a higher tabId. Within one epoch — two
     * tabs that elected themselves in the same instant — the higher tabId wins,
     * as before.
     */
    private resolveDuplicatePrimary;
    private forwardAck;
    private settleAck;
    /**
     * Applies the per-emission `timeout`/`volatile` flags. Values arriving over
     * the channel are untrusted, so the timeout is range-checked here rather
     * than in a schema (the validator cannot express an optional property).
     */
    private applyFlags;
    initialize: () => Promise<void>;
    /**
     * Broadcasts a PRIMARY_CHECK and resolves once the role is settled: as a
     * secondary if a primary answers, as the primary otherwise.
     */
    private startElection;
    private settleElection;
    /**
     * Takes ownership of the socket for this tab, whatever the current election
     * says.
     *
     * The existing primary is asked to stand down and answers once it has; only
     * then does this tab promote itself, so the handover never leaves two sockets
     * open. There is a brief window — one channel round trip — with no primary,
     * which is the safe direction to fail. If nobody answers, this tab promotes
     * anyway after `electionTimeout`.
     *
     * The promotion takes an epoch above every peer's, so a stale primary holding
     * a higher `tabId` cannot win the tie-break and undo it.
     *
     * Resolves once this tab actually holds the socket. Idempotent: calling it on
     * the existing primary resolves immediately. Listeners registered before the
     * call keep working, since they live in the proxy rather than on the socket.
     */
    forcePrimary: () => Promise<void>;
    private completeForcedPromotion;
    /**
     * Pushes this tab's connection state — `connected`, `id`, `active` — to every
     * other tab.
     *
     * Call it when the primary's state changed in a way socket.io did not
     * announce; the lifecycle handlers already do it for ordinary connects and
     * disconnects.
     *
     * Only the primary owns that state, so this is a no-op on a secondary — a
     * secondary has no socket and would otherwise tell every tab the connection
     * is down. Enable `debug` to see when a call was ignored for that reason.
     */
    connectionUpdate: () => void;
    private broadcastConnectionState;
    /**
     * Adopts a connection-state push and tells this tab's listeners about it.
     *
     * Fires on every push it applies, not only on a change: the primary sends
     * these deliberately — including when no socket event is coming — and a
     * receiver that suppressed an unchanged snapshot would leave the caller
     * unable to rely on being told.
     */
    private applyConnectionState;
    /**
     * Broadcasts a socket event to the other tabs. Isolated from socket.io's
     * dispatch loop: a payload that cannot be structured-cloned must surface as
     * a `proxy_error`, not take down event delivery for the whole tab.
     */
    /**
     * Relays a socket or manager event to the other tabs and to this tab's own
     * listeners. Errors do not survive structured cloning, so peers get the
     * message while local listeners keep the real object.
     */
    private relayEvent;
    private dispatchToLocalListeners;
    private notifyPrimaryCheck;
    private announceDeparture;
    private handleUnload;
    /**
     * The page came back — a cancelled navigation, or a restore from the back /
     * forward cache. Undo the departure so the tab rejoins the channel.
     */
    private handlePageShow;
    private addUnloadListeners;
    private removeUnloadListeners;
    private becomePrimary;
    /**
     * Bridges the Manager's reconnection events onto the channel. `socket.io` is
     * the Manager; a browser build always has one, but it is guarded so a test
     * double without it does not break promotion.
     */
    private attachManagerListeners;
    private detachManagerListeners;
    private demotePrimary;
    private startHeartbeat;
    private stopHeartbeat;
    private startHeartbeatMonitor;
    private stopHeartbeatMonitor;
    private assertOpen;
    on: (event: string, callback: (...args: any[]) => void) => void;
    once: (event: string, callback: (...args: any[]) => void) => void;
    off: (event: string, callback?: (...args: any[]) => void) => void;
    emit: (event: string, ...args: any[]) => void;
    emitWithAck: (event: string, ...args: any[]) => Promise<any>;
    /**
     * Subscribes to PRIMARY_CHECK broadcasts from other tabs. Repeat calls add
     * subscribers rather than replacing the previous one.
     *
     * @returns an unsubscribe function.
     */
    onPrimaryCheck: (callback: (...args: any[]) => void) => (() => void);
    get connected(): boolean;
    get disconnected(): boolean;
    /**
     * Whether the channel is *meant* to be connected — seeded from `autoConnect`
     * and moved by `connect()` / `disconnect()` on any tab.
     *
     * Read it alongside `connected` to tell a deliberate offline state from a
     * failed one: `!connected && wantsConnection` is a connection that should be
     * up and is not.
     */
    get wantsConnection(): boolean;
    get io(): any;
    get active(): boolean;
    get id(): string | undefined;
    /**
     * Closes the shared connection and records that the channel is meant to stay
     * closed, so a tab promoted afterwards does not silently reopen it.
     */
    disconnect: () => void;
    /**
     * Opens the shared connection and records that the channel is meant to be
     * open, so a tab promoted by failover opens its socket without the consumer
     * having to call this again.
     */
    connect: () => void;
    volatile: () => this;
    /**
     * Marks the next `emit()` as peer-notifying: the server receives it once, via
     * the primary, and every **other** tab also receives it through its ordinary
     * `on()` listeners.
     *
     * The emitting tab does not receive its own event. Chainable, in the style of
     * `volatile()` and `timeout()`, and consumed by the next emission:
     *
     * ```ts
     * proxy.peers().emit("leave-room", roomId);
     * ```
     *
     * Has no effect on `emitWithAck()`, which is a round trip to the server.
     */
    peers: () => this;
    timeout: (timeout: number) => this;
    /**
     * Sends a custom message to the primary tab's `onProxyMessage` subscribers.
     * When called on the primary itself the message is delivered locally, since
     * BroadcastChannel never echoes to the sender.
     */
    sendMessageToPrimary: (message: ProxyMessage) => void;
    onProxyMessage: (eventName: string, subscriber: (message: any) => void) => (() => void);
    private publishMessage;
    /**
     * Broadcasts an EVENT to the **other** tabs on the channel, without touching
     * the socket.
     *
     * The calling tab does not receive its own event — BroadcastChannel does not
     * echo to the sender, and nothing re-dispatches it locally. Call your own
     * handler directly if you need it on both sides.
     */
    directChannelEmit: (event: string, ...args: any[]) => void;
    /** Tears the proxy down. Idempotent; the instance is unusable afterwards. */
    closeChannel: () => void;
}
