/**
 * Wire protocol version. Bumped whenever the shape or semantics of
 * BroadcastChannel messages change. Tabs running different protocol versions
 * derive different channel tags and therefore ignore each other rather than
 * mis-interpreting one another's messages.
 */
export const PROTOCOL_VERSION = 3;

/**
 * Event names socket.io-client refuses to emit. Emitting one throws inside
 * socket.io, so the proxy rejects them up front on both the primary and the
 * secondary path rather than letting a secondary crash the primary's handler.
 */
export const RESERVED_EVENTS: ReadonlySet<string> = new Set([
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
export const FORWARDED_LIFECYCLE_EVENTS = ["connect", "disconnect", "connect_error"] as const;

/** The lifecycle events after which the primary's connection state has changed. */
export const STATE_CHANGING_EVENTS: ReadonlySet<string> = new Set(["connect", "disconnect"]);

/**
 * Reconnection events. These are emitted on the **Manager** (`socket.io`), not
 * on the socket, so neither `onAny` nor `socket.on` ever sees them. Without
 * this bridge a client that exhausts `reconnectionAttempts` never learns the
 * connection is gone for good.
 */
export const FORWARDED_MANAGER_EVENTS = [
  "reconnect",
  "reconnect_attempt",
  "reconnect_error",
  "reconnect_failed",
] as const;

/** Local-only event emitted when the proxy catches an internal error. */
export const PROXY_ERROR_EVENT = "proxy_error";

/**
 * Local-only event fired on a secondary whenever it applies a connection-state
 * push from the primary. Without it a secondary could only learn that the
 * shared connection changed by polling `connected` / `id` / `active`.
 */
export const CONNECTION_STATE_EVENT = "connection_state_changed";

/**
 * Sentinel for "no socket id". The schema validator type-checks declared
 * properties even when they are not required, so `undefined` cannot be sent
 * over the wire — an empty string is used instead and normalised on receipt.
 */
export const NO_ID = "";
