import { io, Socket, ManagerOptions, SocketOptions } from "socket.io-client";
import validate from "@mdaemon/validate";

const { createSchemaValidator } = validate;

/**
 * Wire protocol version. Bumped whenever the shape or semantics of
 * BroadcastChannel messages change. Tabs running different protocol versions
 * derive different channel tags and therefore ignore each other rather than
 * mis-interpreting one another's messages.
 */
const PROTOCOL_VERSION = 2;

const MESSAGE_TYPES = [
  "PRIMARY_CHECK",
  "PRIMARY_ALIVE",
  "EMIT",
  "EMIT_WITH_ACK",
  "EMIT_WITH_ACK_RESPONSE",
  "EVENT",
  "DISCONNECT",
  "CONNECT",
  "CONNECTION_STATUS",
  "SOCKET_ID_UPDATE",
  "ACTIVE_STATUS_UPDATE",
  "MESSAGE_TO_PRIMARY",
  "HEARTBEAT",
  "PRIMARY_CLAIM",
  "PRIMARY_YIELD",
  "PRIMARY_LEAVING",
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

/** Local-only event emitted when the proxy catches an internal error. */
const PROXY_ERROR_EVENT = "proxy_error";

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

const validateConnectionStatusData = createSchemaValidator("ConnectionStatusData", {
  type: "object",
  required: true,
  properties: {
    connected: { type: "boolean", required: true },
  },
});

const validateSocketIdUpdateData = createSchemaValidator("SocketIdUpdateData", {
  type: "object",
  required: true,
  properties: {
    id: { type: "string", required: true },
  },
});

const validateActiveStatusUpdateData = createSchemaValidator("ActiveStatusUpdateData", {
  type: "object",
  required: true,
  properties: {
    active: { type: "boolean", required: true },
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

const validatePrimaryAliveData = createSchemaValidator("PrimaryAliveData", {
  type: "object",
  required: true,
  properties: {
    tabId: { type: "string", required: true, minLength: 1 },
    connected: { type: "boolean", required: true },
    active: { type: "boolean", required: true },
    id: { type: "string", required: true },
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
  CONNECTION_STATUS: validateConnectionStatusData,
  SOCKET_ID_UPDATE: validateSocketIdUpdateData,
  ACTIVE_STATUS_UPDATE: validateActiveStatusUpdateData,
  MESSAGE_TO_PRIMARY: validateMessageToPrimaryData,
  PRIMARY_ALIVE: validatePrimaryAliveData,
  PRIMARY_CLAIM: validateTabIdData,
  PRIMARY_YIELD: validateTabIdData,
  PRIMARY_LEAVING: validateTabIdData,
  HEARTBEAT: validateTabIdData,
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

  private socket: Socket | null;
  private listeners: Map<string, ((...args: any[]) => void)[]>;
  private options: Partial<ManagerOptions & SocketOptions>;
  private url: string;
  private channel: BroadcastChannel;
  private channelId: string;
  private isConnected: boolean;
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
  private heartbeatInterval: number;
  private heartbeatTimeout: number;
  private electionTimeout: number;
  private electionJitter: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private heartbeatMonitorTimer: ReturnType<typeof setInterval> | null;
  private electionTimer: ReturnType<typeof setTimeout> | null;
  private electionResolvers: (() => void)[];
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
    this.channelId = (isolateByAuth ?? true)
      ? `${channelId}#${digest(stableStringify({
        url,
        auth: socketOptions.auth,
        query: socketOptions.query,
        path: socketOptions.path,
        extraHeaders: socketOptions.extraHeaders,
      }))}`
      : channelId;

    // Derived deterministically so every tab on the channel shares it from
    // construction. This is a protocol/namespace tag that keeps unrelated
    // messages off the wire — it is NOT authentication. Any script on the
    // origin can derive it.
    this.token = `v${PROTOCOL_VERSION}.${digest(`${PROTOCOL_VERSION}:${this.channelId}`)}`;

    this.channel = new BroadcastChannel(this.channelId);
    this.isPrimary = false;
    this.socket = null;
    this.listeners = new Map();
    this.isConnected = false;
    this.primaryCheckSubscribers = new Set();
    this.messageSubscribers = new Map();
    this.pendingAcks = new Map();
    this.tabId = randomHex(24);
    this.socketId = undefined;
    this.socketActive = false;
    this._useVolatile = false;
    this._timeout = null;
    this.heartbeatTimer = null;
    this.heartbeatMonitorTimer = null;
    this.electionTimer = null;
    this.electionResolvers = [];
    this.lastHeartbeat = Date.now();
    this.initPromise = null;
    this.closed = false;
    this.leaving = false;

    // Installed once, up front, and never replaced. Elections are handled by
    // this same handler so no message is ever dropped mid-election.
    this.installMessageHandler();
  }

  /** The effective BroadcastChannel name, including the connection-identity suffix. */
  public get channelName(): string {
    return this.channelId;
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
              connected: !!this.socket?.connected,
              active: !!this.socket?.active,
              id: this.socket?.id ?? NO_ID,
            },
          });
          this.notifyPrimaryCheck();
        }
        break;
      case "PRIMARY_ALIVE":
        if (this.isPrimary && this.electionTimer === null) {
          // Two primaries are alive. Reconcile, but do not adopt the other
          // tab's state — if this one wins the tie-break it would be left
          // reporting a connection it does not own.
          if (data.tabId !== this.tabId) {
            this.resolveDuplicatePrimary(data.tabId);
          }
          break;
        }
        // An existing primary answered. Adopt its state and stand down.
        this.lastHeartbeat = Date.now();
        this.isConnected = data.connected;
        this.socketActive = data.active;
        this.socketId = data.id === NO_ID ? undefined : data.id;
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
      case "CONNECTION_STATUS":
        this.isConnected = data.connected;
        break;
      case "DISCONNECT":
        if (this.isPrimary && this.socket) {
          this.socket.disconnect();
        }
        break;
      case "CONNECT":
        if (this.isPrimary && this.socket) {
          this.socket.connect();
        }
        break;
      case "MESSAGE_TO_PRIMARY":
        if (this.isPrimary) {
          this.publishMessage(data.eventName, data.message);
        }
        break;
      case "SOCKET_ID_UPDATE":
        this.socketId = data.id === NO_ID ? undefined : data.id;
        break;
      case "ACTIVE_STATUS_UPDATE":
        this.socketActive = data.active;
        break;
      case "HEARTBEAT":
        if (this.isPrimary) {
          // Two primaries are alive at once. Reconcile immediately rather than
          // waiting for the next election.
          if (data.tabId !== this.tabId) {
            this.resolveDuplicatePrimary(data.tabId);
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
        if (data.tabId === this.tabId) {
          break;
        }
        if (this.isPrimary) {
          this.resolveDuplicatePrimary(data.tabId);
        }
        else {
          this.lastHeartbeat = Date.now();
          // Someone else won the race; abandon our own pending election.
          if (this.electionTimer !== null) {
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

  /**
   * Deterministic tie-break between two live primaries: the higher tabId keeps
   * the socket, the lower one stands down.
   */
  private resolveDuplicatePrimary = (otherTabId: string): void => {
    if (this.leaving || otherTabId > this.tabId) {
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

  private settleElection = (promote: boolean): void => {
    if (this.electionTimer !== null) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }

    if (promote) {
      this.becomePrimary();
    }
    else {
      this.isPrimary = false;
      this.startHeartbeatMonitor();
    }

    const resolvers = this.electionResolvers;
    this.electionResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }

  private connectionUpdate = (): void => {
    this.isConnected = !!this.socket?.connected;
    this.socketId = this.socket?.id;
    this.socketActive = !!this.socket?.active;
    this.safePost({
      type: "CONNECTION_STATUS",
      data: { connected: !!this.socket?.connected },
    });
    this.safePost({
      type: "SOCKET_ID_UPDATE",
      data: { id: this.socket?.id ?? NO_ID },
    });
    this.safePost({
      type: "ACTIVE_STATUS_UPDATE",
      data: { active: !!this.socket?.active },
    });
  }

  /**
   * Broadcasts a socket event to the other tabs. Isolated from socket.io's
   * dispatch loop: a payload that cannot be structured-cloned must surface as
   * a `proxy_error`, not take down event delivery for the whole tab.
   */
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
      this.safePost({ type: "PRIMARY_CLAIM", data: { tabId: this.tabId } });
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

  private becomePrimary = (): void => {
    if (this.isPrimary || this.closed) {
      return;
    }

    this.isPrimary = true;
    this.leaving = false;

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
          this.connectionUpdate();
        }
        // Errors do not survive structured cloning intact, so peers get the
        // message while local listeners keep the real object.
        const payload = args.map((arg) => (arg instanceof Error ? arg.message : arg));
        this.safePost({ type: "EVENT", data: { event, args: payload } }, `broadcasting "${event}" to other tabs`);
        this.dispatchToLocalListeners(event, ...args);
      });
    });

    this.addUnloadListeners();
    this.startHeartbeat();
    this.stopHeartbeatMonitor();
    this.safePost({ type: "PRIMARY_CLAIM", data: { tabId: this.tabId } });
    this.log("Became primary, tabId:", this.tabId);
  }

  private demotePrimary = (): void => {
    this.log("Demoting from primary");
    this.stopHeartbeat();
    this.removeUnloadListeners();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isPrimary = false;
    this.leaving = false;
    // Listeners live in this.listeners rather than on the socket, so demotion
    // does not lose them.
    this.lastHeartbeat = Date.now();
    this.startHeartbeatMonitor();
  }

  private startHeartbeat = (): void => {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.safePost({ type: "HEARTBEAT", data: { tabId: this.tabId } });
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
    this._useVolatile = false;
    this._timeout = null;

    if (RESERVED_EVENTS.has(event)) {
      // Matches socket.io-client, and stops a secondary from throwing inside
      // the primary's message handler instead of its own call site.
      throw new Error(`"${event}" is a reserved event name`);
    }

    if (this.isPrimary && this.socket) {
      this.applyFlags(this.socket, timeout, volatile).emit(event, ...args);
      return;
    }

    // Flags are only included when set — a key present with an undefined value
    // survives structured cloning and would fail schema validation.
    const data: { event: string; args: any[]; volatile?: boolean; timeout?: number } = { event, args };
    if (volatile) {
      data.volatile = true;
    }
    if (timeout !== null) {
      data.timeout = timeout;
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

  public disconnect = (): void => {
    this.assertOpen("disconnect");
    if (this.isPrimary && this.socket) {
      this.socket.disconnect();
    }
    else {
      this.postMessage({ type: "DISCONNECT" });
    }
  }

  public connect = (): void => {
    this.assertOpen("connect");
    if (this.isPrimary && this.socket) {
      this.socket.connect();
    }
    else {
      this.postMessage({ type: "CONNECT" });
    }
  }

  public volatile = (): this => {
    this._useVolatile = true;
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
   * Broadcasts an EVENT to every tab on the channel without touching the
   * socket. The calling tab's own listeners fire too, since BroadcastChannel
   * does not echo to the sender.
   */
  public directChannelEmit = (event: string, ...args: any[]) => {
    this.assertOpen("directChannelEmit");
    this.postMessage({ type: "EVENT", data: { event, args } });
    this.dispatchToLocalListeners(event, ...args);
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
    const resolvers = this.electionResolvers;
    this.electionResolvers = [];
    resolvers.forEach((resolve) => resolve());

    // Pending acks can never be answered now, so fail them rather than leaving
    // callers hanging until their timeout.
    this.pendingAcks.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new Error("BroadcastChannel closed before the primary responded"));
    });
    this.pendingAcks.clear();

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isPrimary = false;
    this.isConnected = false;
    this.socketActive = false;
    this.socketId = undefined;

    // The instance is unusable now, so held callbacks are pure leak.
    this.listeners.clear();
    this.messageSubscribers.clear();
    this.primaryCheckSubscribers.clear();

    this.channel.onmessage = null;
    this.channel.close();
  };
}
