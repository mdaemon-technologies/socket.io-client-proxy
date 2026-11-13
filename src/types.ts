import type { ManagerOptions, SocketOptions } from "socket.io-client";

/** The public option and payload types. Re-exported from the package entry. */

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
