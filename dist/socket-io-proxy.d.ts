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
    static readonly PROTOCOL_VERSION = 2;
    private socket;
    private listeners;
    private options;
    private url;
    private channel;
    private channelId;
    private isConnected;
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
    private heartbeatInterval;
    private heartbeatTimeout;
    private electionTimeout;
    private electionJitter;
    private heartbeatTimer;
    private heartbeatMonitorTimer;
    private electionTimer;
    private electionResolvers;
    private lastHeartbeat;
    private initPromise;
    private closed;
    private leaving;
    isPrimary: boolean;
    constructor(channelId: string, url: string, options?: SocketIOProxyOptions);
    /** The effective BroadcastChannel name, including the connection-identity suffix. */
    get channelName(): string;
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
    /**
     * Deterministic tie-break between two live primaries: the higher tabId keeps
     * the socket, the lower one stands down.
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
    private connectionUpdate;
    /**
     * Broadcasts a socket event to the other tabs. Isolated from socket.io's
     * dispatch loop: a payload that cannot be structured-cloned must surface as
     * a `proxy_error`, not take down event delivery for the whole tab.
     */
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
    get io(): any;
    get active(): boolean;
    get id(): string | undefined;
    disconnect: () => void;
    connect: () => void;
    volatile: () => this;
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
     * Broadcasts an EVENT to every tab on the channel without touching the
     * socket. The calling tab's own listeners fire too, since BroadcastChannel
     * does not echo to the sender.
     */
    directChannelEmit: (event: string, ...args: any[]) => void;
    /** Tears the proxy down. Idempotent; the instance is unusable afterwards. */
    closeChannel: () => void;
}
