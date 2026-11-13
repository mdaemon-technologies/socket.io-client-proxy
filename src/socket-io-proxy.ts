import { PrimarySocket } from "./connection/primary-socket";
import { ConnectionStateStore, describeSocket } from "./connection/state";
import { defaultDeps, type ProxyDeps } from "./deps";
import { AckTracker, forwardAck } from "./emit/acks";
import { EmitFlags, encodeFlags } from "./emit/flags";
import { closedError, reservedEventError } from "./errors";
import { LocalEmitter } from "./events/local-emitter";
import { KeyedSubscribers, SubscriberSet } from "./events/subscribers";
import { resolveIdentity } from "./identity/identity";
import { IdentityLobby } from "./identity/lobby";
import { assertChannelArgs, DEFAULTS, resolveOptions, type ProxyConfig } from "./options";
import { Primacy } from "./primacy/primacy";
import {
  CONNECTION_STATE_EVENT,
  PROTOCOL_VERSION,
  PROXY_ERROR_EVENT,
  RESERVED_EVENTS,
} from "./protocol/constants";
import type {
  AckResponseData,
  ConnectionStateData,
  EmitData,
  EmitWithAckData,
  MessageHandlers,
} from "./protocol/messages";
import { ChannelTransport } from "./protocol/transport";
import type { ProxyMessage, SocketIOProxyOptions } from "./types.js";
import { createLogger, type Logger } from "./util/log";

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
  public static readonly PROXY_ERROR_EVENT = PROXY_ERROR_EVENT;

  /** Wire protocol version; tabs on different versions ignore each other. */
  public static readonly PROTOCOL_VERSION = PROTOCOL_VERSION;

  /**
   * Local-only event name fired on a secondary when it applies a
   * connection-state push from the primary, with a {@link ConnectionState}
   * snapshot. Subscribe instead of polling `connected` / `id` / `active`.
   */
  public static readonly CONNECTION_STATE_EVENT = CONNECTION_STATE_EVENT;

  private readonly deps: ProxyDeps;
  private readonly config: ProxyConfig;
  private readonly log: Logger;
  private readonly tabId: string;
  private readonly emitter: LocalEmitter;
  private readonly transport: ChannelTransport;
  private readonly lobby: IdentityLobby | null;
  private readonly state: ConnectionStateStore;
  private readonly flags = new EmitFlags();
  private readonly acks: AckTracker;
  private readonly primacy: Primacy;
  private readonly primaryChecks = new SubscriberSet<any[]>();
  private readonly proxyMessages = new KeyedSubscribers<any>();
  /** The real socket, held only while this tab is the primary. */
  private socket: PrimarySocket | null = null;

  constructor(channelId: string, url: string, options: SocketIOProxyOptions = {}) {
    assertChannelArgs(channelId, url);

    this.deps = defaultDeps;
    this.config = resolveOptions(url, options);
    this.log = createLogger(this.config.debug);
    this.tabId = this.deps.randomId(24);
    this.emitter = new LocalEmitter(this.log);

    const identity = resolveIdentity(channelId, url, options, this.config.isolateByAuth);
    this.transport = new ChannelTransport(
      identity.name,
      this.deps.createChannel,
      this.log,
      this.emitter.reportError,
    );

    // Diagnostics only, and only worth opening when isolation is on: without
    // it a mismatched identity is silent, and presents as "the library does
    // not work" rather than as a configuration error.
    this.lobby = this.config.isolateByAuth && this.config.warnOnIdentityMismatch
      ? new IdentityLobby(
        channelId,
        { tabId: this.tabId, fingerprint: identity.fingerprint, keys: identity.keyPaths },
        this.deps.createChannel,
        this.log,
      )
      : null;

    this.state = new ConnectionStateStore(this.config.autoConnect);
    this.acks = new AckTracker(this.config.ackTimeout, this.deps.timers, () => this.deps.randomId(16));
    this.primacy = new Primacy(
      {
        tabId: this.tabId,
        electionTimeout: this.config.electionTimeout,
        electionJitter: this.config.electionJitter,
        heartbeatInterval: this.config.heartbeatInterval,
        heartbeatTimeout: this.config.heartbeatTimeout,
      },
      {
        openSocket: () => this.openSocket(),
        detachSocket: () => this.socket?.detachManager(),
        releaseSocket: () => this.releaseSocket(),
        hasSocket: () => this.socket !== null,
      },
      (message) => this.transport.safePost(message),
      this.deps,
      this.log,
    );
    Object.defineProperty(this, "isPrimary", {
      get: () => this.primacy.isPrimary,
      set: (value: boolean) => {
        this.primacy.isPrimary = value;
      },
      enumerable: true,
      configurable: true,
    });

    // Installed once, up front, and never replaced.
    this.transport.listen(this.handlers);
    this.lobby?.open();
  }

  /**
   * The channel name a given configuration resolves to, without constructing a
   * proxy or opening a channel.
   *
   * Two call sites that are meant to share one socket must produce the same
   * value; asserting that in a test turns a silent runtime split into a build
   * failure.
   */
  public static channelNameFor(
    channelId: string,
    url: string,
    options: SocketIOProxyOptions = {},
  ): string {
    assertChannelArgs(channelId, url);
    // Without isolation the identity is never read, so options it cannot
    // fingerprint (a BigInt in `auth`, say) are not an error here.
    return (options.isolateByAuth ?? DEFAULTS.isolateByAuth)
      ? resolveIdentity(channelId, url, options, true).name
      : channelId;
  }

  /** The effective BroadcastChannel name, including the connection-identity suffix. */
  public get channelName(): string {
    return this.transport.name;
  }

  /**
   * Whether this tab holds the shared socket. Assigning it changes the flag
   * without promoting or demoting anything, so don't.
   */
  // Installed in the constructor as an own, enumerable property over
  // Primacy.isPrimary, so it looks and behaves exactly like the plain field it
  // used to be.
  declare isPrimary: boolean;

  // --- incoming messages ----------------------------------------------------------

  /** One handler per message type; the transport has already validated the payload. */
  private readonly handlers: MessageHandlers = {
    PRIMARY_CHECK: () => this.answerPrimaryCheck(),
    PRIMARY_ALIVE: (data) => this.primacy.onPrimaryAlive(data, () => this.state.apply(data)),
    EVENT: (data) => this.emitter.emit(data.event, ...data.args),
    EMIT: (data) => this.relayEmit(data),
    EMIT_WITH_ACK: (data) => this.relayEmitWithAck(data),
    EMIT_WITH_ACK_RESPONSE: (data) => this.acks.settle(data),
    CONNECTION_STATE: (data) => this.applyConnectionState(data),
    // Intent moves on every tab that hears the request, not just the primary,
    // so a tab whose primary is already dead still promotes into the state
    // the consumer asked for.
    DISCONNECT: () => {
      this.setIntent(false);
    },
    CONNECT: () => {
      this.setIntent(true);
    },
    MESSAGE_TO_PRIMARY: (data) => {
      if (this.isPrimary) {
        this.publishMessage(data.eventName, data.message);
      }
    },
    HEARTBEAT: (data) => this.primacy.onHeartbeat(data),
    PRIMARY_CLAIM: (data) => this.primacy.onClaim(data),
    PRIMARY_YIELD: (data) => this.primacy.onYield(data),
    PRIMARY_DEMAND: (data) => this.primacy.onDemand(data),
    PRIMARY_STOOD_DOWN: (data) => this.primacy.onStoodDown(data),
    PRIMARY_LEAVING: (data) => this.primacy.onLeaving(data),
  };

  private answerPrimaryCheck(): void {
    if (!this.primacy.serving) {
      return;
    }
    this.transport.safePost({
      type: "PRIMARY_ALIVE",
      data: { ...this.primacy.claim(), ...describeSocket(this.socket, this.state.intent) },
    });
    this.primaryChecks.notify([], (err) => {
      this.emitter.reportError("notifying an onPrimaryCheck subscriber", err);
    });
  }

  /** A secondary's `emit()`, arriving at the primary. */
  private relayEmit(data: EmitData): void {
    const owner = this.owner;
    if (owner) {
      if (RESERVED_EVENTS.has(data.event)) {
        this.log("Refusing to emit reserved event name:", data.event);
        return;
      }
      owner.emit(data.event, data.args, data);
    }
    // A peer-notifying emit reaches the server once, via the primary, and
    // every other tab's ordinary listeners. The sender is excluded for
    // free: BroadcastChannel never echoes to it.
    if (data.notifyPeers === true) {
      this.emitter.emit(data.event, ...data.args);
    }
  }

  /** A secondary's `emitWithAck()`, arriving at the primary. */
  private relayEmitWithAck(data: EmitWithAckData): void {
    const owner = this.owner;
    if (!owner) {
      return;
    }
    const respond = (response: AckResponseData) => {
      this.transport.safePost({ type: "EMIT_WITH_ACK_RESPONSE", data: response });
    };
    if (RESERVED_EVENTS.has(data.event)) {
      respond({ id: data.id, error: reservedEventError(data.event).message });
      return;
    }
    forwardAck(() => owner.emitWithAck(data.event, data.args, data), data.id, respond);
  }

  /**
   * Adopts a connection-state push and tells this tab's listeners about it.
   *
   * Fires on every push it applies, not only on a change: the primary sends
   * these deliberately — including when no socket event is coming — and a
   * receiver that suppressed an unchanged snapshot would leave the caller
   * unable to rely on being told.
   */
  private applyConnectionState(data: ConnectionStateData): void {
    this.state.apply(data);
    this.emitter.emit(CONNECTION_STATE_EVENT, this.state.snapshot());
  }

  private publishMessage(eventName: string, message: unknown): void {
    this.proxyMessages.publish(eventName, message, (err) => {
      this.emitter.reportError(`publishing "${eventName}" to a subscriber`, err);
    });
  }

  // --- the primary's socket ---------------------------------------------------

  /** The socket, if this tab is the primary and holds one. */
  private get owner(): PrimarySocket | null {
    return this.isPrimary ? this.socket : null;
  }

  private openSocket(): void {
    const socket: PrimarySocket = new PrimarySocket(
      this.config.url,
      this.config.socketOptions,
      this.deps.createSocket,
      {
        isCurrent: () => this.socket === socket && this.isPrimary,
        relay: this.relayEvent,
        stateChanged: this.broadcastConnectionState,
      },
    );
    this.socket = socket;
    socket.applyIntent(this.state.intent);
  }

  private releaseSocket(): void {
    const socket = this.socket;
    if (socket) {
      // Still current while it disconnects, so its own disconnect event is
      // relayed like any other.
      socket.dispose();
      this.socket = null;
    }
  }

  /**
   * Relays an event to the other tabs and to this tab's own listeners. A
   * payload that cannot be cloned at all surfaces as a `proxy_error` rather
   * than breaking event delivery for the whole tab.
   *
   * Server events go out exactly as they arrived. The socket's lifecycle and
   * Manager events can carry Errors, which do not survive structured cloning,
   * so peers get the message while local listeners keep the real object.
   */
  private relayEvent = (event: string, args: unknown[], source: "server" | "socket"): void => {
    const payload = source === "server"
      ? args
      : args.map((arg) => (arg instanceof Error ? arg.message : arg));
    this.transport.safePost(
      { type: "EVENT", data: { event, args: payload } },
      `broadcasting "${event}" to other tabs`,
    );
    this.emitter.emit(event, ...args);
  };

  private broadcastConnectionState = (): void => {
    this.transport.safePost({ type: "CONNECTION_STATE", data: this.state.capture(this.socket) });
  };

  /**
   * Records the channel's connection intent and, on the primary, acts on it.
   * Setting it before the socket call means an event-driven broadcast already
   * carries it; the explicit push afterwards covers the case where the socket
   * emits nothing at all.
   *
   * @returns whether this tab acted on it; a secondary has to ask the primary.
   */
  private setIntent(wantsConnection: boolean): boolean {
    this.state.intent = wantsConnection;
    const owner = this.owner;
    if (!owner) {
      return false;
    }
    if (wantsConnection) {
      owner.connect();
    }
    else {
      owner.disconnect();
    }
    this.broadcastConnectionState();
    return true;
  }

  // --- lifecycle --------------------------------------------------------------

  private get closed(): boolean {
    return this.transport.closed;
  }

  private assertOpen(action: string): void {
    if (this.closed) {
      throw closedError(action);
    }
  }

  public initialize = (): Promise<void> => this.primacy.initialize();

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
  public forcePrimary = (): Promise<void> => {
    // Rejects rather than throwing synchronously, matching emitWithAck: an
    // async API that throws from the call itself is a footgun, because
    // forcePrimary().catch(...) would not catch it.
    if (this.closed) {
      return Promise.reject(closedError("forcePrimary"));
    }
    return this.primacy.forcePrimary();
  };

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
  public connectionUpdate = (): void => {
    this.assertOpen("connectionUpdate");
    if (!this.owner) {
      this.log("connectionUpdate ignored: only the primary can broadcast connection state");
      return;
    }
    this.broadcastConnectionState();
  };

  /** Tears the proxy down. Idempotent; the instance is unusable afterwards. */
  public closeChannel = (): void => {
    if (this.closed) {
      return;
    }

    // Announced while the channel can still carry it, so peers re-elect
    // immediately.
    this.primacy.announceDeparture();

    // Closed from here on: anything posted below — by the socket's own
    // disconnect handler, say — is dropped.
    this.transport.close();
    this.lobby?.close();

    // Pending acks can never be answered now, so fail them rather than leaving
    // callers hanging until their timeout. Before the socket goes, as it
    // always has, so its disconnect listeners see them already failed.
    this.acks.rejectAll(new Error("BroadcastChannel closed before the primary responded"));

    // Stops the timers and releases the socket.
    this.primacy.close();
    this.state.reset();

    // The instance is unusable now, so held callbacks are pure leak.
    this.emitter.clear();
    this.proxyMessages.clear();
    this.primaryChecks.clear();
  };

  // --- listeners ----------------------------------------------------------------

  public on = (event: string, callback: (...args: any[]) => void): void => {
    this.emitter.on(event, callback);
  };

  public once = (event: string, callback: (...args: any[]) => void): void => {
    this.emitter.once(event, callback);
  };

  public off = (event: string, callback?: (...args: any[]) => void): void => {
    this.emitter.off(event, callback);
  };

  /**
   * Subscribes to PRIMARY_CHECK broadcasts from other tabs. Repeat calls add
   * subscribers rather than replacing the previous one.
   *
   * @returns an unsubscribe function.
   */
  public onPrimaryCheck = (callback: (...args: any[]) => void): (() => void) =>
    this.primaryChecks.add(callback);

  public onProxyMessage = (eventName: string, subscriber: (message: any) => void): (() => void) =>
    this.proxyMessages.subscribe(eventName, subscriber);

  // --- emitting -----------------------------------------------------------------

  public emit = (event: string, ...args: any[]): void => {
    this.assertOpen("emit");

    // Consumed before any validation, so a rejected emission cannot leave a
    // stale flag to be applied to the next one.
    const flags = this.flags.take();

    if (RESERVED_EVENTS.has(event)) {
      // Matches socket.io-client, and stops a secondary from throwing inside
      // the primary's message handler instead of its own call site.
      throw reservedEventError(event);
    }

    const owner = this.owner;
    if (owner) {
      owner.emit(event, args, flags);
      if (flags.notifyPeers) {
        // Straight to the socket, so the peers need a separate EVENT. Still one
        // post, and still not echoed back to this tab.
        this.transport.post({ type: "EVENT", data: { event, args } });
      }
      return;
    }

    const data: EmitData = { event, args, ...encodeFlags(flags) };
    if (flags.notifyPeers) {
      // One message does both jobs: the primary relays it to the server, and
      // every tab but this one hands it to its listeners.
      data.notifyPeers = true;
    }
    this.transport.post({ type: "EMIT", data });
  };

  public emitWithAck = (event: string, ...args: any[]): Promise<any> => {
    // Consumed up front for the same reason as in emit(). peers() is
    // meaningless for a server round trip, but it must still be cleared or it
    // would leak into the next emit().
    const flags = this.flags.take();

    if (this.closed) {
      return Promise.reject(closedError("emitWithAck"));
    }
    if (RESERVED_EVENTS.has(event)) {
      return Promise.reject(reservedEventError(event));
    }

    const owner = this.owner;
    if (owner) {
      return owner.emitWithAck(event, args, flags);
    }

    return this.acks.track((id) => {
      this.transport.post({ type: "EMIT_WITH_ACK", data: { event, args, id, ...encodeFlags(flags) } });
    });
  };

  public volatile = (): this => {
    this.flags.volatile();
    return this;
  };

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
  public peers = (): this => {
    this.flags.peers();
    return this;
  };

  public timeout = (timeout: number): this => {
    this.flags.timeout(timeout);
    return this;
  };

  /**
   * Sends a custom message to the primary tab's `onProxyMessage` subscribers.
   * When called on the primary itself the message is delivered locally, since
   * BroadcastChannel never echoes to the sender.
   */
  public sendMessageToPrimary = (message: ProxyMessage): void => {
    this.assertOpen("sendMessageToPrimary");
    if (!message || typeof message.eventName !== "string" || message.eventName.length === 0) {
      throw new Error("sendMessageToPrimary requires an object with a non-empty 'eventName'");
    }

    if (this.isPrimary) {
      this.publishMessage(message.eventName, message.message);
      return;
    }

    this.transport.post({ type: "MESSAGE_TO_PRIMARY", data: message });
  };

  /**
   * Broadcasts an EVENT to the **other** tabs on the channel, without touching
   * the socket.
   *
   * The calling tab does not receive its own event — BroadcastChannel does not
   * echo to the sender, and nothing re-dispatches it locally. Call your own
   * handler directly if you need it on both sides.
   */
  public directChannelEmit = (event: string, ...args: any[]) => {
    this.assertOpen("directChannelEmit");
    this.transport.post({ type: "EVENT", data: { event, args } });
  };

  // --- connection ---------------------------------------------------------------

  /**
   * Closes the shared connection and records that the channel is meant to stay
   * closed, so a tab promoted afterwards does not silently reopen it.
   */
  public disconnect = (): void => {
    this.assertOpen("disconnect");
    if (!this.setIntent(false)) {
      this.transport.post({ type: "DISCONNECT" });
    }
  };

  /**
   * Opens the shared connection and records that the channel is meant to be
   * open, so a tab promoted by failover opens its socket without the consumer
   * having to call this again.
   */
  public connect = (): void => {
    this.assertOpen("connect");
    if (!this.setIntent(true)) {
      this.transport.post({ type: "CONNECT" });
    }
  };

  public get connected(): boolean {
    return this.state.connected;
  }

  public get disconnected(): boolean {
    return !this.state.connected;
  }

  /**
   * Whether the channel is *meant* to be connected — seeded from `autoConnect`
   * and moved by `connect()` / `disconnect()` on any tab.
   *
   * Read it alongside `connected` to tell a deliberate offline state from a
   * failed one: `!connected && wantsConnection` is a connection that should be
   * up and is not.
   */
  public get wantsConnection(): boolean {
    return this.state.intent;
  }

  public get io(): any {
    return this.isPrimary ? this.socket?.manager : null;
  }

  public get active(): boolean {
    return this.isPrimary ? !!this.socket?.active : this.state.active;
  }

  public get id(): string | undefined {
    return this.owner ? this.owner.id : this.state.id;
  }
}
