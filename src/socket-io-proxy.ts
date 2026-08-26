import { io, Socket, ManagerOptions, SocketOptions } from "socket.io-client";
import validate from "@mdaemon/validate";

const { createSchemaValidator } = validate;

/**
 * Wire protocol version. Bumped whenever the shape or semantics of
 * BroadcastChannel messages change. Tabs running different protocol versions
 * derive different channel tags and therefore ignore each other rather than
 * mis-interpreting one another's messages.
 */
const PROTOCOL_VERSION = 3;

const MESSAGE_TYPES = [
  "PRIMARY_CHECK",
  "PRIMARY_ALIVE",
  "EMIT",
  "EMIT_WITH_ACK",
  "EMIT_WITH_ACK_RESPONSE",
  "EVENT",
  "DISCONNECT",
  "CONNECT",
  "CONNECTION_STATE",
  "MESSAGE_TO_PRIMARY",
  "HEARTBEAT",
  "PRIMARY_CLAIM",
  "PRIMARY_YIELD",
  "PRIMARY_LEAVING",
  "PRIMARY_DEMAND",
  "PRIMARY_STOOD_DOWN",
] as const;

type MessageType = typeof MESSAGE_TYPES[number];

/**
 * Event names socket.io-client refuses to emit. Emitting one throws inside
 * socket.io, so the proxy rejects them up front on both the primary and the
 * secondary path rather than letting a secondary crash the primary's handler.
 */
const RESERVED_EVENTS: ReadonlySet<string> = new Set([
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
]);

/**
 * Socket lifecycle events that `onAny` never fires for. The primary forwards
 * these explicitly so secondaries observe the same lifecycle it does.
 */
const FORWARDED_LIFECYCLE_EVENTS = ["connect", "disconnect", "connect_error"] as const;

/**
 * Reconnection events. These are emitted on the **Manager** (`socket.io`), not
 * on the socket, so neither `onAny` nor `socket.on` ever sees them. Without
 * this bridge a client that exhausts `reconnectionAttempts` never learns the
 * connection is gone for good.
 */
const FORWARDED_MANAGER_EVENTS = [
  "reconnect",
  "reconnect_attempt",
  "reconnect_error",
  "reconnect_failed",
] as const;

/** Local-only event emitted when the proxy catches an internal error. */
const PROXY_ERROR_EVENT = "proxy_error";

/**
 * Local-only event fired on a secondary whenever it applies a connection-state
 * push from the primary. Without it a secondary could only learn that the
 * shared connection changed by polling `connected` / `id` / `active`.
 */
const CONNECTION_STATE_EVENT = "connection_state_changed";

/**
 * Sentinel for "no socket id". The schema validator type-checks declared
 * properties even when they are not required, so `undefined` cannot be sent
 * over the wire — an empty string is used instead and normalised on receipt.
 */
const NO_ID = "";

// Schema validators for each message type's data payload
const validateEmitData = createSchemaValidator("EmitData", {
  type: "object",
  required: true,
  properties: {
    event: { type: "string", required: true, minLength: 1 },
    args: { type: "array", required: true },
  },
});

const validateEmitWithAckData = createSchemaValidator("EmitWithAckData", {
  type: "object",
  required: true,
  properties: {
    event: { type: "string", required: true, minLength: 1 },
    args: { type: "array", required: true },
    id: { type: "string", required: true, minLength: 1 },
  },
});

const validateEmitWithAckResponseData = createSchemaValidator("EmitWithAckResponseData", {
  type: "object",
  required: true,
  properties: {
    id: { type: "string", required: true, minLength: 1 },
  },
});

const validateEventData = createSchemaValidator("EventData", {
  type: "object",
  required: true,
  properties: {
    event: { type: "string", required: true, minLength: 1 },
    args: { type: "array", required: true },
  },
});

/**
 * The connection-state fields travel together in one message. Sent separately
 * they arrived as several events, and the first of them would carry a
 * `connected` that did not yet match the receiver's still-stale `id`.
 *
 * `wantsConnection` rides along for the same reason: it is adopted at exactly
 * the same moments as the rest, and a tab holding intent that disagreed with
 * the snapshot beside it would connect or stay closed for no visible reason.
 */
const validateConnectionStateData = createSchemaValidator("ConnectionStateData", {
  type: "object",
  required: true,
  properties: {
    connected: { type: "boolean", required: true },
    active: { type: "boolean", required: true },
    id: { type: "string", required: true },
    wantsConnection: { type: "boolean", required: true },
  },
});

const validateMessageToPrimaryData = createSchemaValidator("MessageToPrimaryData", {
  type: "object",
  required: true,
  properties: {
    eventName: { type: "string", required: true, minLength: 1 },
  },
});

const validateTabIdData = createSchemaValidator("TabIdData", {
  type: "object",
  required: true,
  properties: {
    tabId: { type: "string", required: true, minLength: 1 },
  },
});

const validateClaimData = createSchemaValidator("ClaimData", {
  type: "object",
  required: true,
  properties: {
    tabId: { type: "string", required: true, minLength: 1 },
    epoch: { type: "number", required: true },
  },
});

const validatePrimaryAliveData = createSchemaValidator("PrimaryAliveData", {
  type: "object",
  required: true,
  properties: {
    tabId: { type: "string", required: true, minLength: 1 },
    epoch: { type: "number", required: true },
    connected: { type: "boolean", required: true },
    active: { type: "boolean", required: true },
    id: { type: "string", required: true },
    wantsConnection: { type: "boolean", required: true },
  },
});

type DataValidator = (data: any) => { valid: boolean; errors: string[] };

/**
 * How each message type's payload is validated. `null` marks a type that
 * carries no payload at all.
 *
 * This is an exhaustive `Record`, not a `Partial`, on purpose: adding a member
 * to MESSAGE_TYPES without an entry here is a compile error, so a new message
 * type can never slip onto the wire unvalidated.
 */
const DATA_VALIDATORS: Record<MessageType, DataValidator | null> = {
  PRIMARY_CHECK: null,
  DISCONNECT: null,
  CONNECT: null,
  EMIT: validateEmitData,
  EMIT_WITH_ACK: validateEmitWithAckData,
  EMIT_WITH_ACK_RESPONSE: validateEmitWithAckResponseData,
  EVENT: validateEventData,
  CONNECTION_STATE: validateConnectionStateData,
  MESSAGE_TO_PRIMARY: validateMessageToPrimaryData,
  PRIMARY_ALIVE: validatePrimaryAliveData,
  PRIMARY_CLAIM: validateClaimData,
  PRIMARY_YIELD: validateTabIdData,
  PRIMARY_LEAVING: validateTabIdData,
  PRIMARY_DEMAND: validateTabIdData,
  PRIMARY_STOOD_DOWN: validateTabIdData,
  HEARTBEAT: validateClaimData,
};

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

interface PendingAck {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const cryptoObj = typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(arr);
  }
  else {
    // Non-secure contexts have no WebCrypto. These ids are collision-avoidance
    // labels, not secrets, so a weaker source is acceptable as a last resort.
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 64-bit FNV-1a-style digest, returned as 16 hex characters. */
function digest(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0")) + ((h2 >>> 0).toString(16).padStart(8, "0"));
}

/**
 * Suffix for the diagnostics lobby — a second channel keyed on the *raw*
 * channel id. Tabs whose identity differs land on different main channels by
 * construction and can never hear each other, which is exactly what makes a
 * misconfigured identity invisible; the lobby is the only place they meet.
 */
const IDENTITY_LOBBY_SUFFIX = "::sioproxy-identity";

/** The options that decide which server principal a connection speaks for. */
function connectionIdentity(url: string, options: SocketIOProxyOptions): Record<string, unknown> {
  return {
    url,
    auth: options.auth,
    query: options.query,
    path: options.path,
    extraHeaders: options.extraHeaders,
  };
}

/**
 * The key *paths* of an identity — `["auth.token", "auth.user", "url"]` — with
 * no values. Two identities that differ in their values are two principals,
 * which is what the isolation is for; two that differ in their key sets are
 * almost always one principal described inconsistently, which is a bug.
 *
 * Only names ever go on the wire, never values.
 */
function identityKeys(identity: Record<string, unknown>): string[] {
  const keys: string[] = [];
  Object.keys(identity).sort().forEach((field) => {
    const value = identity[field];
    if (value === undefined || value === null) {
      return;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      Object.keys(value as Record<string, unknown>).sort().forEach((k) => keys.push(`${field}.${k}`));
    }
    else {
      keys.push(field);
    }
  });
  return keys;
}

/** Deterministic JSON with sorted keys, so equivalent options hash identically. */
function stableStringify(value: any, seen: Set<any> = new Set()): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  const type = typeof value;
  if (type === "function") return `fn:${String(value)}`;
  if (type !== "object") return JSON.stringify(value) ?? String(value);
  if (seen.has(value)) return "[cyclic]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => stableStringify(v, seen)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], seen)}`).join(",")}}`;
  }
  finally {
    seen.delete(value);
  }
}

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

  private socket: Socket | null;
  private listeners: Map<string, ((...args: any[]) => void)[]>;
  private options: Partial<ManagerOptions & SocketOptions>;
  private url: string;
  private channel: BroadcastChannel;
  private channelId: string;
  private lobby: BroadcastChannel | null;
  private rawChannelId: string;
  private identityFingerprint: string;
  private identityKeyPaths: string[];
  private warnedIdentities: Set<string>;
  private isConnected: boolean;
  /**
   * The channel's connection intent — whether the socket is *meant* to be open.
   * Channel-wide rather than per-tab, so that a tab promoted by failover opens
   * a socket the consumer asked for on some other tab, and does not open one
   * the consumer closed there.
   */
  private connectionIntent: boolean;
  private primaryCheckSubscribers: Set<(...args: any[]) => void>;
  private messageSubscribers: Map<string, Set<(message: any) => void>>;
  private pendingAcks: Map<string, PendingAck>;
  private token: string;
  private ackTimeout: number;
  private debug: boolean;
  private tabId: string;
  private socketId: string | undefined;
  private socketActive: boolean;
  private _useVolatile: boolean;
  private _timeout: number | null;
  private _notifyPeers: boolean;
  private heartbeatInterval: number;
  private heartbeatTimeout: number;
  private electionTimeout: number;
  private electionJitter: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private heartbeatMonitorTimer: ReturnType<typeof setInterval> | null;
  private electionTimer: ReturnType<typeof setTimeout> | null;
  private electionResolvers: (() => void)[];
  private forceTimer: ReturnType<typeof setTimeout> | null;
  private forceResolvers: (() => void)[];
  private managerListeners: [string, (...args: any[]) => void][];
  /** This tab's primacy epoch; 0 while it is not the primary. */
  private epoch: number;
  /** Highest epoch seen from any tab, so a promotion can outrank every peer. */
  private highestSeenEpoch: number;
  private lastHeartbeat: number;
  private initPromise: Promise<void> | null;
  private closed: boolean;
  private leaving: boolean;
  public isPrimary: boolean;

  constructor(channelId: string, url: string, options: SocketIOProxyOptions = {}) {
    if (!channelId || typeof channelId !== "string") {
      throw new Error("channelId is required and must be a non-empty string");
    }
    if (!url || typeof url !== "string") {
      throw new Error("url is required and must be a non-empty string");
    }

    const {
      debug,
      heartbeatInterval,
      heartbeatTimeout,
      ackTimeout,
      electionTimeout,
      electionJitter,
      isolateByAuth,
      warnOnIdentityMismatch,
      ...socketOptions
    } = options;

    this.url = url;
    this.options = socketOptions;
    this.debug = debug ?? false;
    this.ackTimeout = ackTimeout ?? 10000;
    this.heartbeatInterval = heartbeatInterval ?? 3000;
    this.heartbeatTimeout = heartbeatTimeout ?? 10000;
    this.electionTimeout = electionTimeout ?? 2000;
    this.electionJitter = electionJitter ?? 250;

    // Tabs whose connection identity differs must not share a socket, so the
    // identity is folded into the channel name. Tabs with matching identity
    // derive the same name and share as before.
    const identity = connectionIdentity(url, options);
    const isolate = isolateByAuth ?? true;
    this.identityFingerprint = digest(stableStringify(identity));
    this.identityKeyPaths = identityKeys(identity);
    this.warnedIdentities = new Set();
    this.rawChannelId = channelId;
    this.channelId = isolate ? `${channelId}#${this.identityFingerprint}` : channelId;

    // Derived deterministically so every tab on the channel shares it from
    // construction. This is a protocol/namespace tag that keeps unrelated
    // messages off the wire — it is NOT authentication. Any script on the
    // origin can derive it.
    this.token = `v${PROTOCOL_VERSION}.${digest(`${PROTOCOL_VERSION}:${this.channelId}`)}`;

    this.channel = new BroadcastChannel(this.channelId);

    // Diagnostics only, and only worth opening when isolation is on: without
    // it a mismatched identity is silent, and presents as "the library does
    // not work" rather than as a configuration error.
    this.lobby = isolate && (warnOnIdentityMismatch ?? true)
      ? new BroadcastChannel(`${channelId}${IDENTITY_LOBBY_SUFFIX}`)
      : null;
    this.isPrimary = false;
    this.socket = null;
    this.listeners = new Map();
    this.isConnected = false;
    // Seeded from this tab's own autoConnect, then overwritten by the channel's
    // intent if a primary answers the election — an established channel's
    // decision outranks a newcomer's default.
    this.connectionIntent = options.autoConnect !== false;
    this.primaryCheckSubscribers = new Set();
    this.messageSubscribers = new Map();
    this.pendingAcks = new Map();
    this.tabId = randomHex(24);
    this.socketId = undefined;
    this.socketActive = false;
    this._useVolatile = false;
    this._timeout = null;
    this._notifyPeers = false;
    this.heartbeatTimer = null;
    this.heartbeatMonitorTimer = null;
    this.electionTimer = null;
    this.electionResolvers = [];
    this.forceTimer = null;
    this.forceResolvers = [];
    this.managerListeners = [];
    this.epoch = 0;
    this.highestSeenEpoch = 0;
    this.lastHeartbeat = Date.now();
    this.initPromise = null;
    this.closed = false;
    this.leaving = false;

    // Installed once, up front, and never replaced. Elections are handled by
    // this same handler so no message is ever dropped mid-election.
    this.installMessageHandler();
    this.announceIdentity();
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
    if (!channelId || typeof channelId !== "string") {
      throw new Error("channelId is required and must be a non-empty string");
    }
    if (!url || typeof url !== "string") {
      throw new Error("url is required and must be a non-empty string");
    }
    return (options.isolateByAuth ?? true)
      ? `${channelId}#${digest(stableStringify(connectionIdentity(url, options)))}`
      : channelId;
  }

  /** The effective BroadcastChannel name, including the connection-identity suffix. */
  public get channelName(): string {
    return this.channelId;
  }

  private announceIdentity = (): void => {
    if (!this.lobby) {
      return;
    }
    this.lobby.onmessage = (event: MessageEvent) => this.handleLobbyMessage(event.data);
    this.postLobby("announce");
  }

  private postLobby = (kind: "announce" | "reply"): void => {
    if (!this.lobby || this.closed) {
      return;
    }
    try {
      this.lobby.postMessage({
        kind,
        tabId: this.tabId,
        fingerprint: this.identityFingerprint,
        keys: this.identityKeyPaths,
      });
    }
    catch (err) {
      // Diagnostics must never be able to break a working proxy.
      this.log("Could not announce identity:", err);
    }
  }

  /**
   * Hand-checked rather than schema-validated: this is a diagnostics
   * side-channel, not part of the wire protocol, and anything unrecognised is
   * simply ignored.
   */
  private handleLobbyMessage = (raw: any): void => {
    try {
      if (!raw || typeof raw !== "object") {
        return;
      }
      const { kind, tabId, fingerprint, keys } = raw;
      if (kind !== "announce" && kind !== "reply") {
        return;
      }
      if (typeof tabId !== "string" || typeof fingerprint !== "string" || tabId === this.tabId) {
        return;
      }
      if (!Array.isArray(keys) || !keys.every((k: unknown) => typeof k === "string")) {
        return;
      }

      // Answer an announcement so the newcomer learns about this tab too.
      // Replies are never answered, so the exchange cannot ping-pong.
      if (kind === "announce") {
        this.postLobby("reply");
      }

      if (fingerprint === this.identityFingerprint) {
        return;
      }
      this.reportIdentityMismatch(keys as string[]);
    }
    catch (err) {
      this.log("Error while handling an identity announcement:", err);
    }
  }

  /**
   * Warns only when the two identities are described by different *key sets*.
   * Matching keys with differing values means two principals, which is the
   * whole point of the isolation and must stay silent.
   */
  private reportIdentityMismatch = (peerKeys: string[]): void => {
    const mine = this.identityKeyPaths;
    const onlyHere = mine.filter((k) => !peerKeys.includes(k));
    const onlyThere = peerKeys.filter((k) => !mine.includes(k));

    if (onlyHere.length === 0 && onlyThere.length === 0) {
      return;
    }

    const signature = `${onlyHere.join(",")}|${onlyThere.join(",")}`;
    if (this.warnedIdentities.has(signature)) {
      return;
    }
    this.warnedIdentities.add(signature);

    const differences = [
      onlyHere.length ? `only here: ${onlyHere.join(", ")}` : null,
      onlyThere.length ? `only there: ${onlyThere.join(", ")}` : null,
    ].filter(Boolean).join("; ");

    console.warn(
      `[SocketIOProxy] Another tab on channel "${this.rawChannelId}" is using a different `
      + `connection identity, so the two are NOT sharing a socket (${differences}). `
      + `Tabs that differ deliberately — different signed-in users — are meant to get separate `
      + `connections, but the option keys differ here, which usually means one principal is being `
      + `described inconsistently. Compare the options every SocketIOProxy for this channel is `
      + `constructed with; SocketIOProxy.channelNameFor() will tell you whether two call sites `
      + `agree. Pass warnOnIdentityMismatch: false to silence this.`,
    );
  }

  private validateMessage(raw: any): { valid: boolean; type?: MessageType; data?: any; errors?: string[] } {
    if (raw == null || typeof raw !== "object") {
      return { valid: false, errors: ["Message is not an object"] };
    }

    const { type, data, token } = raw;

    if (!type || typeof type !== "string" || !MESSAGE_TYPES.includes(type as MessageType)) {
      return { valid: false, errors: [`Invalid message type: ${type}`] };
    }

    const msgType = type as MessageType;

    // Every message — elections included — carries the channel tag. Because it
    // is derived from the channel id rather than generated per tab, tabs that
    // elect themselves independently can still reconcile with one another.
    if (token !== this.token) {
      return { valid: false, errors: ["Invalid or missing message token"] };
    }

    const validator = DATA_VALIDATORS[msgType];
    if (validator) {
      const result = validator(data);
      if (!result.valid) {
        return { valid: false, type: msgType, errors: result.errors };
      }
    }

    return { valid: true, type: msgType, data };
  }

  /**
   * Posts a message, letting failures reach the caller. Used for the paths a
   * user drives directly, where a payload that cannot be structured-cloned is
   * worth surfacing at the call site.
   */
  private postMessage(msg: { type: MessageType; data?: any }): void {
    if (this.closed) {
      this.log("Dropped outgoing message on a closed channel:", msg.type);
      return;
    }
    this.channel.postMessage({ ...msg, token: this.token });
  }

  /**
   * Posts a message that nobody is waiting on — protocol traffic, heartbeats,
   * state broadcasts. These run inside timers, socket.io's dispatch loop and
   * the BroadcastChannel callback, where a throw would take down the tab or
   * surface as an unhandled rejection, so failures are reported instead.
   */
  private safePost(msg: { type: MessageType; data?: any }, context?: string): void {
    try {
      this.postMessage(msg);
    }
    catch (err) {
      this.reportError(context ?? `sending ${msg.type}`, err);
    }
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log("[SocketIOProxy]", ...args);
    }
  }

  /**
   * Reports an internal error to `proxy_error` listeners without letting it
   * escape into the BroadcastChannel callback, where nothing could catch it.
   */
  private reportError = (context: string, error: unknown): void => {
    this.log("Error while", context, error);
    const listeners = this.listeners.get(PROXY_ERROR_EVENT);
    if (!listeners || listeners.length === 0) {
      return;
    }
    const wrapped = error instanceof Error ? error : new Error(String(error));
    listeners.slice().forEach((callback) => {
      try {
        callback(wrapped, context);
      }
      catch {
        /* a failing error handler must not re-enter reportError */
      }
    });
  }

  private installMessageHandler = (): void => {
    this.channel.onmessage = (event: MessageEvent) => {
      let validation;
      try {
        validation = this.validateMessage(event.data);
      }
      catch (err) {
        this.reportError("validating a BroadcastChannel message", err);
        return;
      }

      if (!validation.valid) {
        this.log("BroadcastChannel message rejected:", validation.errors);
        return;
      }

      try {
        this.handleMessage(validation.type as MessageType, validation.data);
      }
      catch (err) {
        // A malformed or hostile message must never take down the handler.
        this.reportError(`handling a ${validation.type} message`, err);
      }
    };
  }

  private handleMessage(type: MessageType, data: any): void {
    switch (type) {
      case "PRIMARY_CHECK":
        // A primary that has announced its departure must stay quiet, or it
        // answers the very election its own PRIMARY_LEAVING triggered.
        if (this.isPrimary && !this.leaving) {
          this.safePost({
            type: "PRIMARY_ALIVE",
            data: {
              tabId: this.tabId,
              epoch: this.epoch,
              connected: !!this.socket?.connected,
              active: !!this.socket?.active,
              id: this.socket?.id ?? NO_ID,
              wantsConnection: this.connectionIntent,
            },
          });
          this.notifyPrimaryCheck();
        }
        break;
      case "PRIMARY_ALIVE":
        this.observeEpoch(data.epoch);
        if (this.isPrimary && this.electionTimer === null) {
          // Two primaries are alive. Reconcile, but do not adopt the other
          // tab's state — if this one wins the tie-break it would be left
          // reporting a connection it does not own.
          if (data.tabId !== this.tabId) {
            this.resolveDuplicatePrimary(data.tabId, data.epoch);
          }
          break;
        }
        // An existing primary answered. Adopt its state and stand down.
        //
        // Deliberately silent: this lands during initialize(), before the
        // caller has had a chance to subscribe, and the state is readable from
        // the getters the moment initialize() resolves.
        this.lastHeartbeat = Date.now();
        this.isConnected = data.connected;
        this.socketActive = data.active;
        this.socketId = data.id === NO_ID ? undefined : data.id;
        // The channel's intent outranks this tab's own autoConnect default: a
        // newcomer must not drag a deliberately-offline channel online, nor sit
        // closed on a channel that is meant to be up.
        this.connectionIntent = data.wantsConnection;
        if (this.electionTimer !== null) {
          this.settleElection(false);
        }
        break;
      case "EVENT":
        this.dispatchToLocalListeners(data.event, ...data.args);
        break;
      case "EMIT":
        if (this.isPrimary && this.socket) {
          if (RESERVED_EVENTS.has(data.event)) {
            this.log("Refusing to emit reserved event name:", data.event);
            break;
          }
          this.applyFlags(this.socket, data.timeout, data.volatile).emit(data.event, ...data.args);
        }
        // A peer-notifying emit reaches the server once, via the primary, and
        // every other tab's ordinary listeners. The sender is excluded for
        // free: BroadcastChannel never echoes to it.
        if (data.notifyPeers === true) {
          this.dispatchToLocalListeners(data.event, ...data.args);
        }
        break;
      case "EMIT_WITH_ACK":
        if (this.isPrimary && this.socket) {
          if (RESERVED_EVENTS.has(data.event)) {
            this.safePost({
              type: "EMIT_WITH_ACK_RESPONSE",
              data: { id: data.id, error: `"${data.event}" is a reserved event name` },
            });
            break;
          }
          this.forwardAck(data);
        }
        break;
      case "EMIT_WITH_ACK_RESPONSE":
        this.settleAck(data);
        break;
      case "CONNECTION_STATE":
        this.applyConnectionState(data.connected, data.id, data.active, data.wantsConnection);
        break;
      // Intent moves on every tab that hears the request, not just the primary,
      // so a tab whose primary is already dead still promotes into the state
      // the consumer asked for. Setting it before the socket call means an
      // event-driven broadcast already carries it; the explicit push afterwards
      // covers the case where the socket emits nothing at all.
      case "DISCONNECT":
        this.connectionIntent = false;
        if (this.isPrimary && this.socket) {
          this.socket.disconnect();
          this.broadcastConnectionState();
        }
        break;
      case "CONNECT":
        this.connectionIntent = true;
        if (this.isPrimary && this.socket) {
          this.socket.connect();
          this.broadcastConnectionState();
        }
        break;
      case "MESSAGE_TO_PRIMARY":
        if (this.isPrimary) {
          this.publishMessage(data.eventName, data.message);
        }
        break;
      case "HEARTBEAT":
        this.observeEpoch(data.epoch);
        if (this.isPrimary) {
          // Two primaries are alive at once. Reconcile immediately rather than
          // waiting for the next election.
          if (data.tabId !== this.tabId) {
            this.resolveDuplicatePrimary(data.tabId, data.epoch);
          }
        }
        else {
          this.lastHeartbeat = Date.now();
          if (this.electionTimer !== null) {
            this.settleElection(false);
          }
        }
        break;
      case "PRIMARY_CLAIM":
        this.observeEpoch(data.epoch);
        if (data.tabId === this.tabId) {
          break;
        }
        if (this.isPrimary) {
          this.resolveDuplicatePrimary(data.tabId, data.epoch);
        }
        else {
          this.lastHeartbeat = Date.now();
          // Someone else won the race; abandon our own pending election. A
          // forced promotion is deliberate and outranks the claim, so it is
          // left to run.
          if (this.electionTimer !== null && this.forceTimer === null) {
            this.settleElection(false);
          }
        }
        break;
      case "PRIMARY_YIELD":
        // Targeted at exactly one tab, so an unrelated primary is never demoted.
        if (this.isPrimary && data.tabId === this.tabId) {
          this.log("Received PRIMARY_YIELD, demoting");
          this.demotePrimary();
        }
        break;
      case "PRIMARY_DEMAND":
        // Another tab is claiming the socket deliberately. Stand down without
        // arguing — a demand outranks the tabId tie-break by design — and tell
        // it the socket is free.
        if (data.tabId !== this.tabId && this.isPrimary) {
          this.log("Primary demanded by", data.tabId, "- standing down");
          this.demotePrimary();
          this.safePost({ type: "PRIMARY_STOOD_DOWN", data: { tabId: data.tabId } });
        }
        break;
      case "PRIMARY_STOOD_DOWN":
        if (data.tabId === this.tabId && this.forceTimer !== null) {
          this.completeForcedPromotion();
        }
        break;
      case "PRIMARY_LEAVING":
        // The primary is going away. Re-elect now instead of waiting out
        // heartbeatTimeout.
        if (!this.isPrimary && data.tabId !== this.tabId) {
          this.log("Primary is leaving, starting election");
          this.stopHeartbeatMonitor();
          void this.startElection();
        }
        break;
    }
  }

  /** Tracks the highest primacy epoch seen, so a promotion can outrank it. */
  private observeEpoch = (epoch: unknown): void => {
    if (typeof epoch === "number" && Number.isFinite(epoch) && epoch > this.highestSeenEpoch) {
      this.highestSeenEpoch = epoch;
    }
  }

  /**
   * Deterministic tie-break between two live primaries.
   *
   * The more recently elected primary wins: a tab promoted at a higher epoch
   * outranks one at a lower epoch, which is what lets `forcePrimary()` survive
   * a stale peer that happens to hold a higher tabId. Within one epoch — two
   * tabs that elected themselves in the same instant — the higher tabId wins,
   * as before.
   */
  private resolveDuplicatePrimary = (otherTabId: string, otherEpoch: unknown): void => {
    const theirs = typeof otherEpoch === "number" && Number.isFinite(otherEpoch) ? otherEpoch : 0;
    const outranked = theirs > this.epoch || (theirs === this.epoch && otherTabId > this.tabId);

    if (this.leaving || outranked) {
      this.log("Duplicate primary detected, yielding to", otherTabId);
      this.demotePrimary();
    }
    else {
      this.safePost({ type: "PRIMARY_YIELD", data: { tabId: otherTabId } });
    }
  }

  private forwardAck = (data: any): void => {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    const { event, args, id } = data;

    void (async () => {
      try {
        const response = await this.applyFlags(socket, data.timeout, data.volatile)
          .emitWithAck(event, ...args);
        this.safePost({ type: "EMIT_WITH_ACK_RESPONSE", data: { id, response } });
      }
      catch (err) {
        this.safePost({
          type: "EMIT_WITH_ACK_RESPONSE",
          data: { id, response: undefined, error: err instanceof Error ? err.message : String(err) },
        });
      }
    })();
  }

  private settleAck = (data: any): void => {
    const pending = this.pendingAcks.get(data.id);
    if (!pending) {
      return;
    }
    this.pendingAcks.delete(data.id);
    clearTimeout(pending.timer);
    if (typeof data.error === "string" && data.error.length > 0) {
      pending.reject(new Error(data.error));
    }
    else {
      pending.resolve(data.response);
    }
  }

  /**
   * Applies the per-emission `timeout`/`volatile` flags. Values arriving over
   * the channel are untrusted, so the timeout is range-checked here rather
   * than in a schema (the validator cannot express an optional property).
   */
  private applyFlags = (socket: Socket, timeout?: number | null, volatile?: boolean): Socket => {
    let target = socket;
    if (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0) {
      target = target.timeout(timeout) as unknown as Socket;
    }
    if (volatile === true) {
      target = target.volatile as unknown as Socket;
    }
    return target;
  }

  public initialize = (): Promise<void> => {
    // Repeat calls must not stack a second election or a second set of timers.
    if (!this.initPromise) {
      this.initPromise = this.startElection();
    }
    return this.initPromise;
  }

  /**
   * Broadcasts a PRIMARY_CHECK and resolves once the role is settled: as a
   * secondary if a primary answers, as the primary otherwise.
   */
  private startElection = (): Promise<void> => {
    if (this.closed) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.electionResolvers.push(resolve);

      if (this.electionTimer !== null) {
        // An election is already running; join it rather than starting another.
        return;
      }

      // Jitter staggers simultaneous elections so one tab wins outright.
      const delay = this.electionTimeout + Math.floor(Math.random() * (this.electionJitter + 1));
      this.electionTimer = setTimeout(() => this.settleElection(true), delay);
      // A check that cannot be sent is not fatal: the timer still fires and
      // this tab promotes itself, which is the right fallback.
      this.safePost({ type: "PRIMARY_CHECK" });
    });
  }

  private settleElection = (promote: boolean, epoch?: number): void => {
    if (this.electionTimer !== null) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }

    if (promote) {
      this.becomePrimary(epoch);
    }
    else {
      this.isPrimary = false;
      this.startHeartbeatMonitor();
    }

    const resolvers = this.electionResolvers;
    this.electionResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }

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
      return Promise.reject(new Error("Cannot forcePrimary after closeChannel() has been called"));
    }

    if (this.isPrimary && !this.leaving) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.forceResolvers.push(resolve);

      if (this.forceTimer !== null) {
        // A demand is already in flight; join it rather than issuing another.
        return;
      }

      // A later initialize() must not start a competing election.
      if (!this.initPromise) {
        this.initPromise = Promise.resolve();
      }

      this.stopHeartbeatMonitor();
      this.forceTimer = setTimeout(() => {
        // Nobody answered, so there is no primary to wait for.
        this.log("No primary answered the demand, promoting");
        this.completeForcedPromotion();
      }, this.electionTimeout);

      this.log("Demanding primary, tabId:", this.tabId);
      this.safePost({ type: "PRIMARY_DEMAND", data: { tabId: this.tabId } });
    });
  }

  private completeForcedPromotion = (): void => {
    if (this.forceTimer !== null) {
      clearTimeout(this.forceTimer);
      this.forceTimer = null;
    }

    // settleElection also clears any ordinary election that was in flight and
    // resolves the callers waiting on it.
    this.settleElection(true, this.highestSeenEpoch + 1);

    const resolvers = this.forceResolvers;
    this.forceResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }

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
    if (!this.isPrimary || !this.socket) {
      this.log("connectionUpdate ignored: only the primary can broadcast connection state");
      return;
    }
    this.broadcastConnectionState();
  }

  private broadcastConnectionState = (): void => {
    this.isConnected = !!this.socket?.connected;
    this.socketId = this.socket?.id;
    this.socketActive = !!this.socket?.active;
    this.safePost({
      type: "CONNECTION_STATE",
      data: {
        connected: this.isConnected,
        active: this.socketActive,
        id: this.socketId ?? NO_ID,
        wantsConnection: this.connectionIntent,
      },
    });
  }

  /**
   * Adopts a connection-state push and tells this tab's listeners about it.
   *
   * Fires on every push it applies, not only on a change: the primary sends
   * these deliberately — including when no socket event is coming — and a
   * receiver that suppressed an unchanged snapshot would leave the caller
   * unable to rely on being told.
   */
  private applyConnectionState = (
    connected: boolean,
    id: string,
    active: boolean,
    wantsConnection: boolean,
  ): void => {
    this.isConnected = connected;
    this.socketId = id === NO_ID ? undefined : id;
    this.socketActive = active;
    this.connectionIntent = wantsConnection;

    const snapshot: ConnectionState = {
      connected: this.isConnected,
      id: this.socketId,
      active: this.socketActive,
      wantsConnection: this.connectionIntent,
    };
    this.dispatchToLocalListeners(CONNECTION_STATE_EVENT, snapshot);
  }

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
  private relayEvent = (event: string, args: any[]): void => {
    const payload = args.map((arg) => (arg instanceof Error ? arg.message : arg));
    this.safePost({ type: "EVENT", data: { event, args: payload } }, `broadcasting "${event}" to other tabs`);
    this.dispatchToLocalListeners(event, ...args);
  }

  private dispatchToLocalListeners = (event: string, ...args: any[]): void => {
    const callbacks = this.listeners.get(event);
    if (!callbacks) {
      return;
    }
    // Copied so a listener that unsubscribes during dispatch cannot skip a peer.
    callbacks.slice().forEach((callback) => {
      try {
        callback(...args);
      }
      catch (err) {
        this.reportError(`dispatching "${event}" to a listener`, err);
      }
    });
  }

  private notifyPrimaryCheck = (): void => {
    this.primaryCheckSubscribers.forEach((callback) => {
      try {
        callback();
      }
      catch (err) {
        this.reportError("notifying an onPrimaryCheck subscriber", err);
      }
    });
  }

  private announceDeparture = (): void => {
    if (!this.isPrimary || this.leaving || this.closed) {
      return;
    }
    // Marked before the broadcast so the ensuing election is not answered by
    // the tab that is on its way out.
    this.leaving = true;
    this.stopHeartbeat();
    this.safePost({ type: "PRIMARY_LEAVING", data: { tabId: this.tabId } });
  }

  private handleUnload = (): void => {
    this.announceDeparture();
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
    if (this.isPrimary && this.socket) {
      this.startHeartbeat();
      this.safePost({ type: "PRIMARY_CLAIM", data: { tabId: this.tabId, epoch: this.epoch } });
    }
    else {
      this.startHeartbeatMonitor();
    }
  }

  private addUnloadListeners = (): void => {
    if (typeof window === "undefined") {
      return;
    }
    window.addEventListener("beforeunload", this.handleUnload);
    // beforeunload does not fire reliably on mobile or under bfcache.
    window.addEventListener("pagehide", this.handleUnload);
    window.addEventListener("pageshow", this.handlePageShow);
  }

  private removeUnloadListeners = (): void => {
    if (typeof window === "undefined") {
      return;
    }
    window.removeEventListener("beforeunload", this.handleUnload);
    window.removeEventListener("pagehide", this.handleUnload);
    window.removeEventListener("pageshow", this.handlePageShow);
  }

  private becomePrimary = (epoch?: number): void => {
    if (this.isPrimary || this.closed) {
      return;
    }

    this.isPrimary = true;
    this.leaving = false;
    // A promotion always takes an epoch above everything seen so far, so the
    // newest primary outranks any stale one still holding a socket.
    this.epoch = Math.max(epoch ?? 0, this.highestSeenEpoch + 1);
    this.highestSeenEpoch = this.epoch;

    const socket = io(this.url, this.options);
    this.socket = socket;

    // Handlers stay attached to a socket this tab has since let go of, so each
    // one checks that it is still the live one before speaking for the channel.
    const isCurrent = () => this.socket === socket && this.isPrimary;

    socket.onAny((event: string, ...args: any[]) => {
      if (!isCurrent()) {
        return;
      }
      this.safePost({ type: "EVENT", data: { event, args } }, `broadcasting "${event}" to other tabs`);
      this.dispatchToLocalListeners(event, ...args);
    });

    // onAny never fires for these, so they are forwarded explicitly.
    FORWARDED_LIFECYCLE_EVENTS.forEach((event) => {
      socket.on(event as any, (...args: any[]) => {
        if (!isCurrent()) {
          return;
        }
        if (event === "connect" || event === "disconnect") {
          this.broadcastConnectionState();
        }
        this.relayEvent(event, args);
      });
    });

    // Reconnection events live on the Manager, not the socket. They are
    // attached separately and detached on demotion, because the Manager can
    // outlive the socket this tab was using.
    this.attachManagerListeners(socket, isCurrent);

    // `io()` opens the socket itself under the default autoConnect, so this is
    // a no-op for most consumers. With autoConnect false nothing else ever
    // opens it: a tab promoted by failover would hold a socket that never
    // connects, report `connected: false` forever, and never raise an error —
    // because nothing was attempted. Promotion is the point at which the
    // channel's intent has to be applied to a brand new socket.
    //
    // The `else` covers a Manager cached by an earlier `io()` call, whose
    // autoConnect was fixed before this proxy existed and which may therefore
    // have opened the socket against the channel's wishes.
    if (this.connectionIntent) {
      if (!socket.active) {
        socket.connect();
      }
    }
    else if (socket.active || socket.connected) {
      socket.disconnect();
    }

    this.addUnloadListeners();
    this.startHeartbeat();
    this.stopHeartbeatMonitor();
    this.safePost({ type: "PRIMARY_CLAIM", data: { tabId: this.tabId, epoch: this.epoch } });
    this.log("Became primary, tabId:", this.tabId, "epoch:", this.epoch);
  }

  /**
   * Bridges the Manager's reconnection events onto the channel. `socket.io` is
   * the Manager; a browser build always has one, but it is guarded so a test
   * double without it does not break promotion.
   */
  private attachManagerListeners = (socket: Socket, isCurrent: () => boolean): void => {
    const manager: any = socket.io;
    if (!manager || typeof manager.on !== "function") {
      return;
    }

    FORWARDED_MANAGER_EVENTS.forEach((event) => {
      const handler = (...args: any[]) => {
        if (!isCurrent()) {
          return;
        }
        this.relayEvent(event, args);
      };
      manager.on(event, handler);
      this.managerListeners.push([event, handler]);
    });
  }

  private detachManagerListeners = (): void => {
    const manager: any = this.socket?.io;
    if (manager && typeof manager.off === "function") {
      this.managerListeners.forEach(([event, handler]) => manager.off(event, handler));
    }
    this.managerListeners = [];
  }

  private demotePrimary = (): void => {
    this.log("Demoting from primary");
    this.stopHeartbeat();
    this.detachManagerListeners();
    this.removeUnloadListeners();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isPrimary = false;
    this.leaving = false;
    this.epoch = 0;
    // Listeners live in this.listeners rather than on the socket, so demotion
    // does not lose them.
    this.lastHeartbeat = Date.now();
    this.startHeartbeatMonitor();
  }

  private startHeartbeat = (): void => {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.safePost({ type: "HEARTBEAT", data: { tabId: this.tabId, epoch: this.epoch } });
    }, this.heartbeatInterval);
  }

  private stopHeartbeat = (): void => {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeatMonitor = (): void => {
    this.stopHeartbeatMonitor();
    if (this.closed) {
      return;
    }
    this.lastHeartbeat = Date.now();
    this.heartbeatMonitorTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > this.heartbeatTimeout) {
        this.log("Primary heartbeat lost, initiating re-election");
        this.stopHeartbeatMonitor();
        void this.startElection();
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeatMonitor = (): void => {
    if (this.heartbeatMonitorTimer) {
      clearInterval(this.heartbeatMonitorTimer);
      this.heartbeatMonitorTimer = null;
    }
  }

  private assertOpen(action: string): void {
    if (this.closed) {
      throw new Error(`Cannot ${action} after closeChannel() has been called`);
    }
  }

  public on = (event: string, callback: (...args: any[]) => void): void => {
    // Always stored locally, never on the socket, so that a primary demoted
    // mid-session keeps every listener it was given.
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.push(callback);
    }
    else {
      this.listeners.set(event, [callback]);
    }
  }

  public once = (event: string, callback: (...args: any[]) => void): void => {
    const wrappedCallback = (...args: any[]) => {
      this.off(event, wrappedCallback);
      callback(...args);
    };
    this.on(event, wrappedCallback);
  }

  public off = (event: string, callback?: (...args: any[]) => void): void => {
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

  public emit = (event: string, ...args: any[]): void => {
    this.assertOpen("emit");

    // Consumed before any validation, so a rejected emission cannot leave a
    // stale flag to be applied to the next one.
    const volatile = this._useVolatile;
    const timeout = this._timeout;
    const notifyPeers = this._notifyPeers;
    this._useVolatile = false;
    this._timeout = null;
    this._notifyPeers = false;

    if (RESERVED_EVENTS.has(event)) {
      // Matches socket.io-client, and stops a secondary from throwing inside
      // the primary's message handler instead of its own call site.
      throw new Error(`"${event}" is a reserved event name`);
    }

    if (this.isPrimary && this.socket) {
      this.applyFlags(this.socket, timeout, volatile).emit(event, ...args);
      if (notifyPeers) {
        // Straight to the socket, so the peers need a separate EVENT. Still one
        // post, and still not echoed back to this tab.
        this.postMessage({ type: "EVENT", data: { event, args } });
      }
      return;
    }

    // Flags are only included when set — a key present with an undefined value
    // survives structured cloning and would fail schema validation.
    const data: {
      event: string; args: any[]; volatile?: boolean; timeout?: number; notifyPeers?: boolean;
    } = { event, args };
    if (volatile) {
      data.volatile = true;
    }
    if (timeout !== null) {
      data.timeout = timeout;
    }
    if (notifyPeers) {
      // One message does both jobs: the primary relays it to the server, and
      // every tab but this one hands it to its listeners.
      data.notifyPeers = true;
    }
    this.postMessage({ type: "EMIT", data });
  }

  public emitWithAck = (event: string, ...args: any[]): Promise<any> => {
    // Consumed up front for the same reason as in emit(): a rejected emission
    // must not leave a stale flag behind for the next one.
    const volatile = this._useVolatile;
    const timeout = this._timeout;
    this._useVolatile = false;
    this._timeout = null;
    // peers() is meaningless for a server round trip, but it must still be
    // cleared or it would leak into the next emit().
    this._notifyPeers = false;

    if (this.closed) {
      return Promise.reject(new Error("Cannot emitWithAck after closeChannel() has been called"));
    }
    if (RESERVED_EVENTS.has(event)) {
      return Promise.reject(new Error(`"${event}" is a reserved event name`));
    }

    if (this.isPrimary && this.socket) {
      return this.applyFlags(this.socket, timeout, volatile).emitWithAck(event, ...args);
    }

    return new Promise((resolve, reject) => {
      const id = randomHex(16);
      const data: { event: string; args: any[]; id: string; volatile?: boolean; timeout?: number } =
        { event, args, id };
      if (volatile) {
        data.volatile = true;
      }
      if (timeout !== null) {
        data.timeout = timeout;
      }

      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error("emitWithAck timed out waiting for primary response"));
      }, this.ackTimeout);

      // Registered before posting, so a primary that answers synchronously is
      // never missed.
      this.pendingAcks.set(id, { resolve, reject, timer });
      try {
        this.postMessage({ type: "EMIT_WITH_ACK", data });
      }
      catch (err) {
        clearTimeout(timer);
        this.pendingAcks.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Subscribes to PRIMARY_CHECK broadcasts from other tabs. Repeat calls add
   * subscribers rather than replacing the previous one.
   *
   * @returns an unsubscribe function.
   */
  public onPrimaryCheck = (callback: (...args: any[]) => void): (() => void) => {
    this.primaryCheckSubscribers.add(callback);
    return () => {
      this.primaryCheckSubscribers.delete(callback);
    };
  };

  public get connected(): boolean {
    return this.isConnected;
  }

  public get disconnected(): boolean {
    return !this.isConnected;
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
    return this.connectionIntent;
  }

  public get io(): any {
    return this.isPrimary ? this.socket?.io : null;
  }

  public get active(): boolean {
    return this.isPrimary ? !!this.socket?.active : this.socketActive;
  }

  public get id(): string | undefined {
    if (this.isPrimary && this.socket) {
      return this.socket.id;
    }
    return this.socketId;
  }

  /**
   * Closes the shared connection and records that the channel is meant to stay
   * closed, so a tab promoted afterwards does not silently reopen it.
   */
  public disconnect = (): void => {
    this.assertOpen("disconnect");
    this.connectionIntent = false;
    if (this.isPrimary && this.socket) {
      this.socket.disconnect();
      this.broadcastConnectionState();
    }
    else {
      this.postMessage({ type: "DISCONNECT" });
    }
  }

  /**
   * Opens the shared connection and records that the channel is meant to be
   * open, so a tab promoted by failover opens its socket without the consumer
   * having to call this again.
   */
  public connect = (): void => {
    this.assertOpen("connect");
    this.connectionIntent = true;
    if (this.isPrimary && this.socket) {
      this.socket.connect();
      this.broadcastConnectionState();
    }
    else {
      this.postMessage({ type: "CONNECT" });
    }
  }

  public volatile = (): this => {
    this._useVolatile = true;
    return this;
  }

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
    this._notifyPeers = true;
    return this;
  }

  public timeout = (timeout: number): this => {
    this._timeout = timeout;
    return this;
  }

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

    this.postMessage({ type: "MESSAGE_TO_PRIMARY", data: message });
  }

  public onProxyMessage = (eventName: string, subscriber: (message: any) => void): (() => void) => {
    let subscribers = this.messageSubscribers.get(eventName);
    if (!subscribers) {
      subscribers = new Set();
      this.messageSubscribers.set(eventName, subscribers);
    }
    subscribers.add(subscriber);

    return () => {
      const current = this.messageSubscribers.get(eventName);
      if (!current) {
        return;
      }
      current.delete(subscriber);
      if (current.size === 0) {
        this.messageSubscribers.delete(eventName);
      }
    };
  };

  private publishMessage = (eventName: string, message: any) => {
    const subscribers = this.messageSubscribers.get(eventName);
    if (!subscribers) {
      return;
    }
    Array.from(subscribers).forEach((subscriber) => {
      try {
        subscriber(message);
      }
      catch (err) {
        this.reportError(`publishing "${eventName}" to a subscriber`, err);
      }
    });
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
    this.postMessage({ type: "EVENT", data: { event, args } });
  };

  /** Tears the proxy down. Idempotent; the instance is unusable afterwards. */
  public closeChannel = (): void => {
    if (this.closed) {
      return;
    }

    // Announced before the channel closes so peers re-elect immediately.
    this.announceDeparture();

    this.closed = true;
    this.stopHeartbeat();
    this.stopHeartbeatMonitor();
    this.removeUnloadListeners();

    if (this.electionTimer !== null) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
    if (this.forceTimer !== null) {
      clearTimeout(this.forceTimer);
      this.forceTimer = null;
    }
    const resolvers = [...this.electionResolvers, ...this.forceResolvers];
    this.electionResolvers = [];
    this.forceResolvers = [];
    resolvers.forEach((resolve) => resolve());

    // Pending acks can never be answered now, so fail them rather than leaving
    // callers hanging until their timeout.
    this.pendingAcks.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new Error("BroadcastChannel closed before the primary responded"));
    });
    this.pendingAcks.clear();

    this.detachManagerListeners();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isPrimary = false;
    this.epoch = 0;
    this.isConnected = false;
    this.socketActive = false;
    this.socketId = undefined;

    // The instance is unusable now, so held callbacks are pure leak.
    this.listeners.clear();
    this.messageSubscribers.clear();
    this.primaryCheckSubscribers.clear();

    this.channel.onmessage = null;
    this.channel.close();
    if (this.lobby) {
      this.lobby.onmessage = null;
      this.lobby.close();
      this.lobby = null;
    }
  };
}
