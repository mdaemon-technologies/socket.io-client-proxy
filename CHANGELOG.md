# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-25

A correctness and hardening release. The public API is backward compatible —
every existing method keeps its signature, and all new options are additive —
but the inter-tab wire protocol changed, so please read
[Upgrade notes](#upgrade-notes-110) before rolling this out.

### Fixed

- **Split brain: two tabs opened at the same moment could both stay primary
  forever.** `PRIMARY_CLAIM` is the only message that resolves duplicate
  primaries, but it was validated against a per-tab random token. Two tabs that
  elected themselves independently therefore rejected each other's claim as
  "Invalid or missing message token", never reconciled, and each held its own
  socket connection permanently — defeating the point of the library. The
  channel tag is now derived from the channel id, so every tab on a channel
  agrees on it from construction and election messages always validate.

- **Demotion silently dropped listeners and blacked the tab out.** Listeners
  registered via `on()`/`once()` while a tab was primary went straight onto the
  socket, so `demotePrimary()` discarded them along with the socket. The demoted
  tab also kept its own token and could not validate the new primary's traffic
  until a full `heartbeatTimeout` had elapsed. Listeners are now always held in
  the proxy's own registry, and the shared channel tag removes the blackout.

- **`off()` could not remove a listener registered while primary.** It called
  `socket.off()` only, so a callback held in the local registry stayed
  subscribed forever. Registration is now uniform, and `off()` works in both
  roles.

- **`SOCKET_ID_UPDATE` and `SOCKET_ID_RESPONSE` were rejected on every
  disconnect.** socket.io deletes `socket.id` on close, and the schema validator
  type-checks a declared property even when it is not required — so
  `{ id: undefined }` failed validation and was dropped by every secondary,
  leaving `proxy.id` stale indefinitely. A `""` sentinel is now sent and
  normalised back to `undefined` on receipt.

- **`emitWithAck` turned failures into successful `undefined`.** The primary
  correctly forwarded `error`, but the secondary ignored it and always resolved.
  Callers could not tell "the server acked with undefined" from "the emit
  failed". The returned promise now rejects with the reported error.

- **Prototype-chain event names crashed the message handler.** The listener map
  was a plain object, so `on("__proto__", cb)` and an incoming `EVENT` named
  `constructor`, `toString` or `hasOwnProperty` threw a `TypeError` — a
  cross-tab denial of service reachable by any script on the origin. Listeners
  are now held in a `Map`.

- **A reserved event name from a secondary threw inside the primary.**
  socket.io refuses to emit `connect`, `connect_error`, `disconnect`,
  `disconnecting`, `newListener` and `removeListener`. A secondary calling
  `emit("disconnect")` saw no error locally but raised an uncaught exception in
  the primary tab. `emit()` and `emitWithAck()` now reject reserved names at the
  call site, the primary ignores them if they arrive anyway, and the whole
  message handler is wrapped so no message can take it down.

- **`closeChannel()` left the instance in a state that threw.** It nulled the
  socket but kept `isPrimary` true, so a later `emit()` posted to a closed
  channel and raised `InvalidStateError`. It is now idempotent, clears role
  state, detaches the handler, and rejects pending `emitWithAck` calls instead
  of leaving them to time out.

- **Closing the primary tab caused a full `heartbeatTimeout` outage.** The old
  `PRIMARY_YIELD` announcement was only acted on by other primaries, so
  secondaries waited out the whole timeout plus an election. A departing primary
  now broadcasts `PRIMARY_LEAVING` and secondaries re-elect immediately.

- **A departing primary answered the election its own departure triggered.**
  Between announcing departure and actually unloading, the tab still replied to
  `PRIMARY_CHECK`, so the failover was cancelled and no tab took over. A
  departing primary now stays quiet and always stands down when reconciling.

- **Re-election dropped all traffic for two seconds.** `checkPrimary()`
  reassigned `channel.onmessage` to a handler that discarded everything except
  `PRIMARY_ALIVE`. The handler is now installed once in the constructor and
  never replaced, so nothing is lost mid-election — including messages that
  arrive before `initialize()` is called.

- **Every tab received a spurious `connect` event whenever any new tab
  opened.** Answering a `PRIMARY_CHECK` broadcast a synthetic `connect` to the
  whole channel. `PRIMARY_ALIVE` now carries the primary's state directly to the
  tab that asked, so a joining tab has an accurate `connected`, `id` and
  `active` the moment `initialize()` resolves.

- **`PRIMARY_YIELD` demoted every primary that saw it.** It is now addressed to a
  specific `tabId`.

- **`initialize()` was not idempotent** — a second call stacked another election
  and another set of timers. Repeat calls now share one promise.

- **A pending `timeout()`/`volatile()` flag leaked to the next emission** when
  the emit it was meant for was rejected.

- **`emitWithAck()` ignored `timeout()` and `volatile()` entirely** — and left
  them set, so the flag silently applied itself to the *next* `emit()` instead.
  `proxy.timeout(500).emitWithAck(...)` now behaves as it does in
  `socket.io-client`, and a secondary forwards the flags for the primary to
  apply. It also no longer leaks a pending timer when the payload cannot be
  posted.

- **A background broadcast that threw could take down the tab.** Heartbeats,
  election checks and state broadcasts run inside timers, socket.io's dispatch
  loop and the BroadcastChannel callback, where a throw is unrecoverable — an
  election check that failed surfaced as an unhandled promise rejection. Those
  paths now report on `proxy_error` and carry on; a failed election check still
  falls back to self-promotion. Calls a user makes directly (`emit`,
  `emitWithAck`, `directChannelEmit`, `sendMessageToPrimary`) still throw at the
  call site, where the caller can act on it.

- **A discarded socket could still broadcast as though it owned the channel.**
  The `onAny` and lifecycle handlers stayed attached to the socket a demoted tab
  had let go of. They now check they are still the live socket before speaking
  for the channel.

- **`closeChannel()` held on to every listener and subscriber.** The instance is
  unusable afterwards, so those references were pure leak; they are released
  along with the cached socket id.

- **`sendMessageToPrimary()` was a no-op when called on the primary**, since
  BroadcastChannel never echoes to the sender. It now delivers locally. Its
  parameter is also properly typed as `ProxyMessage` — the previous `any`
  hid the fact that a non-empty `eventName` is required, and messages without
  one were silently discarded.

- **`connect_error` never reached secondaries.** `onAny` does not fire for
  socket lifecycle events; they are now forwarded explicitly.

- **`require()` of the published bundle returned an empty object.** The package
  is `"type": "module"`, so Node parses `dist/*.js` as ESM and the UMD wrapper's
  CommonJS branch never ran — `require(".../socket-io-proxy.umd.js")` returned
  `{}` and leaked a `globalThis.SocketIOProxy` instead. A `.cjs` build is now
  emitted, and `main` / `exports.require` point at it. The `.js` UMD file is
  unchanged for `<script>` tags, and `exports` now lists `types` first so
  TypeScript resolves declarations correctly. (Present since 1.0.x.)

- Updated transitive dependencies to clear three advisories reported by
  `npm audit` (`ws` uninitialized memory disclosure and fragment DoS,
  `socket.io-parser` memory exhaustion). Both resolve within the existing
  `socket.io-client ^4.8.3` range, so a fresh install picks them up.

### Security

- **Tabs authenticated as different principals no longer share a socket.**
  Only the elected primary's options reached `io()`, so a tab that signed in as
  a different user silently kept consuming the first account's event stream
  while believing it had passed its own credentials. The effective channel name
  now includes a fingerprint of the connection identity (`url` plus `auth`,
  `query`, `path` and `extraHeaders`), so mismatched tabs land on separate
  channels and get separate connections. Opt out with `isolateByAuth: false`.

  **Limitation:** a dynamic `auth` *callback* cannot be fingerprinted — only its
  source is visible, and that is identical across tabs even when the token it
  returns differs. Applications using one must scope `channelId` themselves.

- **A forged `PRIMARY_ALIVE` can no longer hijack a tab.** Handshake messages
  used to skip validation, and a joining tab adopted whatever token they
  carried. Any script on the origin could race the election window with a forged
  reply and make the tab a permanent secondary of a nonexistent primary,
  forwarding all of its emits to the attacker. Every message type is now
  validated, and tokens are never adopted from the wire.

- The channel tag is documented for what it actually is: a protocol and
  namespace marker that keeps unrelated messages off the wire, **not**
  authentication. BroadcastChannel is same-origin, so any script on the origin
  can derive the tag and use the shared socket. Do not build a trust boundary on
  it.

### Added

- `electionTimeout` and `electionJitter` options. The election delay was
  previously hardcoded at 2000 ms; the jitter staggers simultaneous elections so
  one tab wins outright rather than every tab promoting itself at once.
- `isolateByAuth` option (default `true`) — see **Security** above.
- `channelName` getter, exposing the effective BroadcastChannel name including
  the connection-identity suffix.
- `proxy_error` event (`SocketIOProxy.PROXY_ERROR_EVENT`). Internal errors the
  proxy catches — a throwing listener, a malformed message — are reported here
  instead of escaping into the BroadcastChannel callback where nothing could
  catch them. Handlers receive `(error, context)`.
- `SocketIOProxy.PROTOCOL_VERSION` static. Both statics are exposed on the class
  rather than as named exports, so the bundle keeps a single default export and
  `require(".../socket-io-proxy.umd.js")` still returns the class itself.
- `ProxyMessage` interface for `sendMessageToPrimary()`.
- `onPrimaryCheck()` now supports multiple subscribers and returns an
  unsubscribe function, matching `onProxyMessage()`.
- `url` is validated in the constructor, as `channelId` already was.
- `pagehide` is observed alongside `beforeunload`, which does not fire reliably
  on mobile or under the back/forward cache. `pageshow` undoes a departure when
  a page is restored or a navigation is cancelled.
- A duplicate-primary backstop: a heartbeat from an unexpected `tabId`
  reconciles the split even if the `PRIMARY_CLAIM` was missed.

### Changed

- Listeners are always stored in the proxy rather than on the socket. `on()`,
  `once()` and `off()` now behave identically whether the tab is primary or
  secondary.
- A listener that throws no longer aborts the dispatch to its peers; the error
  is reported on `proxy_error`.
- `directChannelEmit()` also dispatches to the calling tab's own listeners.
  BroadcastChannel does not echo to the sender, so the emitting tab previously
  never saw its own event.
- Removed the `GET_SOCKET_ID` / `SOCKET_ID_RESPONSE` message pair. Nothing ever
  sent the request — it was unreachable in 1.0.x too — and it is now redundant:
  `PRIMARY_ALIVE` carries the id when a tab joins, and `SOCKET_ID_UPDATE` fires
  on every change.
- Internal cleanups: a single `applyFlags` helper replaces four
  `as unknown as Socket` casts, field declarations are grouped at the top of the
  class, and `RESERVED_EVENTS` is a `Set`. The payload-validator table is now an
  exhaustive `Record<MessageType, …>` rather than a `Partial`, so adding a
  message type without deciding how it is validated is a compile error instead
  of a silently unvalidated payload.

### Tests

- The suite grew from 82 to 208 specs and is split across several files.
  Registering roughly ninety or more tests in a single file overflows the stack
  in this jest/jsdom environment — even `expect(1).toBe(1)` then fails — so the
  split is load-bearing, not just organisational.
- `@mdaemon/validate` is no longer mocked. The hand-rolled stand-in accepted
  `undefined` for non-required string properties while the real library rejects
  it, which is exactly what hid the `SOCKET_ID_UPDATE` bug above.
- The crypto mock is counter-based, so each proxy gets a distinct `tabId`. The
  previous constant mock gave every instance the same id, making the
  duplicate-primary tie-break unreachable in tests.
- Added a BroadcastChannel bus that really routes messages between instances, so
  elections, split brain and failover are exercised across several live proxies
  rather than simulated one tab at a time. It can buffer traffic, which is how
  the split-brain regression is reproduced.
- The bus clones with real structured-clone semantics rather than a JSON
  round-trip, so a payload the proxy could not actually send between tabs fails
  in tests too. jest's jsdom has no `structuredClone`, so a setup file supplies
  one backed by Node's `v8` serializer.

### Upgrade notes {#upgrade-notes-110}

- **Mixed versions do not interoperate.** The channel tag embeds
  `PROTOCOL_VERSION`, so a tab on 1.0.x and a tab on 1.1.0 ignore each other and
  each elects its own primary — two connections until every tab has reloaded.
  This is deliberate: silently mixing the two protocols would be worse. Expect
  it during a rollout.
- **The BroadcastChannel name changed** to `"<channelId>#<fingerprint>"` unless
  you pass `isolateByAuth: false`. This matters only if something outside the
  proxy opens the same channel by name.
- **`emit("connect")` and friends now throw.** They always threw on a primary
  (socket.io's own behaviour); secondaries used to fail silently and crash the
  primary instead.
- **`sendMessageToPrimary()` now throws** when given a payload without a
  non-empty `eventName`, rather than discarding it silently. The required shape
  is unchanged and was already documented.
- **`onPrimaryCheck()` is additive.** It used to replace the previous callback;
  it now registers alongside it and returns an unsubscribe function.
- **`emitWithAck()` now honours a pending `timeout()`/`volatile()`.** If you
  chained one before an `emitWithAck` it used to be ignored and then leak into
  your next `emit()`; it now applies to the `emitWithAck` itself, which can make
  a slow acknowledgement reject where it previously hung until `ackTimeout`.
- **CommonJS deep imports must target `.cjs`.** Bare
  `require("@mdaemon/socket.io-client-proxy")` now works; a deep import of
  `dist/socket-io-proxy.umd.js` must become `dist/socket-io-proxy.umd.cjs`. The
  old path never actually worked under `require`, so nothing that worked before
  breaks.

## [1.0.2] - 2026-05-19

- README badge and link corrections.

## [1.0.1]

- Initial published releases.

[1.1.0]: https://github.com/mdaemon-technologies/socket.io-client-proxy/releases/tag/v1.1.0
[1.0.2]: https://github.com/mdaemon-technologies/socket.io-client-proxy/releases/tag/v1.0.2
[1.0.1]: https://github.com/mdaemon-technologies/socket.io-client-proxy/releases/tag/v1.0.1
