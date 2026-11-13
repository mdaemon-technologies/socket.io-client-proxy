import type { ProxyMessage, SocketIOProxyOptions } from "./types.js";
export type { ConnectionState, ProxyMessage, SocketIOProxyOptions } from "./types.js";
/**
 * Shares one socket.io connection between the browser tabs of an origin.
 *
 * This class is the public API and the wiring between the parts that do the
 * work: the channel transport, the primacy coordinator, the primary's socket,
 * the shared connection state, the local listeners and the ack tracker.
 */
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
    private readonly deps;
    private readonly config;
    private readonly log;
    private readonly tabId;
    private readonly emitter;
    private readonly transport;
    private readonly lobby;
    private readonly state;
    private readonly flags;
    private readonly acks;
    private readonly primacy;
    private readonly primaryChecks;
    private readonly proxyMessages;
    /** The real socket, held only while this tab is the primary. */
    private socket;
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
    /**
     * Whether this tab holds the shared socket. Assigning it changes the flag
     * without promoting or demoting anything, so don't.
     */
    isPrimary: boolean;
    /** One handler per message type; the transport has already validated the payload. */
    private readonly handlers;
    private answerPrimaryCheck;
    /** A secondary's `emit()`, arriving at the primary. */
    private relayEmit;
    /** A secondary's `emitWithAck()`, arriving at the primary. */
    private relayEmitWithAck;
    /**
     * Adopts a connection-state push and tells this tab's listeners about it.
     *
     * Fires on every push it applies, not only on a change: the primary sends
     * these deliberately — including when no socket event is coming — and a
     * receiver that suppressed an unchanged snapshot would leave the caller
     * unable to rely on being told.
     */
    private applyConnectionState;
    private publishMessage;
    /** The socket, if this tab is the primary and holds one. */
    private get owner();
    private openSocket;
    private releaseSocket;
    /**
     * Relays an event to the other tabs and to this tab's own listeners. A
     * payload that cannot be cloned at all surfaces as a `proxy_error` rather
     * than breaking event delivery for the whole tab.
     *
     * Server events go out exactly as they arrived. The socket's lifecycle and
     * Manager events can carry Errors, which do not survive structured cloning,
     * so peers get the message while local listeners keep the real object.
     */
    private relayEvent;
    private broadcastConnectionState;
    /**
     * Records the channel's connection intent and, on the primary, acts on it.
     * Setting it before the socket call means an event-driven broadcast already
     * carries it; the explicit push afterwards covers the case where the socket
     * emits nothing at all.
     *
     * @returns whether this tab acted on it; a secondary has to ask the primary.
     */
    private setIntent;
    private get closed();
    private assertOpen;
    initialize: () => Promise<void>;
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
    /** Tears the proxy down. Idempotent; the instance is unusable afterwards. */
    closeChannel: () => void;
    on: (event: string, callback: (...args: any[]) => void) => void;
    once: (event: string, callback: (...args: any[]) => void) => void;
    off: (event: string, callback?: (...args: any[]) => void) => void;
    /**
     * Subscribes to PRIMARY_CHECK broadcasts from other tabs. Repeat calls add
     * subscribers rather than replacing the previous one.
     *
     * @returns an unsubscribe function.
     */
    onPrimaryCheck: (callback: (...args: any[]) => void) => (() => void);
    onProxyMessage: (eventName: string, subscriber: (message: any) => void) => (() => void);
    emit: (event: string, ...args: any[]) => void;
    emitWithAck: (event: string, ...args: any[]) => Promise<any>;
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
    /**
     * Broadcasts an EVENT to the **other** tabs on the channel, without touching
     * the socket.
     *
     * The calling tab does not receive its own event — BroadcastChannel does not
     * echo to the sender, and nothing re-dispatches it locally. Call your own
     * handler directly if you need it on both sides.
     */
    directChannelEmit: (event: string, ...args: any[]) => void;
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
}
