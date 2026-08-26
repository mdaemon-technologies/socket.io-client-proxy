[![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmdaemon-technologies%2Fsocket.io-client-proxy%2Fmain%2Fpackage.json&query=%24.version&prefix=v&label=npm&color=blue)](https://www.npmjs.com/package/@mdaemon/socket.io-client-proxy) [![Static Badge](https://img.shields.io/badge/node-v18%2B-blue?style=flat&label=node&color=blue)](https://nodejs.org) [![install size](https://packagephobia.com/badge?p=@mdaemon/socket.io-client-proxy)](https://packagephobia.com/result?p=@mdaemon/socket.io-client-proxy) [![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmdaemon-technologies%2Fsocket.io-client-proxy%2Fmain%2Fpackage.json&query=%24.license&prefix=v&label=license&color=green)](https://github.com/mdaemon-technologies/socket.io-client-proxy/blob/main/LICENSE) [![Node.js CI](https://github.com/mdaemon-technologies/socket.io-client-proxy/actions/workflows/node.js.yml/badge.svg)](https://github.com/mdaemon-technologies/socket.io-client-proxy/actions/workflows/node.js.yml)

# @mdaemon/socket.io-client-proxy

**Tired of every browser tab opening its own WebSocket connection?** SocketIOProxy uses the BroadcastChannel API to elect a single "primary" tab that holds the socket.io connection, while all other tabs communicate through it seamlessly.

A lightweight TypeScript proxy that gives every tab full socket.io semantics (`on`, `emit`, `emitWithAck`, `connect`, `disconnect`) without multiplying server connections — tested, typed, and ready to drop in.

## Why SocketIOProxy?

| Feature | Description |
|---------|-------------|
| **Single connection** | Only one tab maintains the actual socket.io connection |
| **Automatic primary election** | Tabs negotiate who holds the connection via BroadcastChannel |
| **Transparent API** | Same `on`/`emit`/`off` interface whether primary or secondary |
| **emitWithAck support** | Acknowledgement round-trips work across tabs |
| **Connection state sync** | All tabs know `connected`, `disconnected`, `active`, and `id` |
| **Primary failover** | New tabs detect missing primary and promote themselves |
| **Inter-tab messaging** | `sendMessageToPrimary` / `onProxyMessage` for custom communication |
| **Identity isolation** | Tabs authenticated as different users never share a connection |
| **Zero config** | Works with any socket.io-client setup — just swap the import |
| **Fully typed** | TypeScript with full IntelliSense |

### When to use this

- Chat applications open across multiple tabs
- Dashboards with real-time data where each tab doesn't need its own connection
- Any app where users routinely have multiple tabs open to the same domain

---

## Install

```bash
npm install @mdaemon/socket.io-client-proxy --save
```

Both module systems resolve automatically:

```javascript
import SocketIOProxy from "@mdaemon/socket.io-client-proxy";   // ESM
const SocketIOProxy = require("@mdaemon/socket.io-client-proxy"); // CommonJS
```

### Deep imports

```javascript
// CommonJS - must be the .cjs build. The package is "type": "module", so Node
// parses dist/*.js as ESM and the UMD wrapper's CommonJS branch never runs.
const SocketIOProxy = require("@mdaemon/socket.io-client-proxy/dist/socket-io-proxy.umd.cjs");

// ES Modules
import SocketIOProxy from "@mdaemon/socket.io-client-proxy/dist/socket-io-proxy.mjs";
```

### Browser
The UMD build expects `socket.io-client` to already be on the page as the global
`io`, so load it first:

```html
<script src="/path_to_modules/socket.io-client/dist/socket.io.min.js"></script>
<script src="/path_to_modules/dist/socket-io-proxy.umd.js"></script>
<script>
  const proxy = new SocketIOProxy("my-app-channel", "https://my-server.com");
</script>
```

---

## Quick Start

```typescript
import SocketIOProxy from "@mdaemon/socket.io-client-proxy";

const proxy = new SocketIOProxy("my-app-channel", "https://my-server.com", {
  // standard socket.io-client options
  transports: ["websocket"],
  auth: { token: "abc" }
});

await proxy.initialize();

// Use exactly like socket.io-client
proxy.on("message", (data) => {
  console.log("Received:", data);
});

proxy.emit("chat", "Hello from any tab!");

// Acknowledgements work too
const response = await proxy.emitWithAck("request", { id: 1 });
console.log("Server replied:", response);
```

---

## How It Works

1. **Construction** — Each tab creates a `SocketIOProxy` instance with the same `channelId`. The effective channel name also includes a fingerprint of the connection identity, so tabs with different credentials are kept apart (see [Identity isolation](#identity-isolation)).
2. **`initialize()`** — The tab broadcasts a `PRIMARY_CHECK`. If an existing primary answers within `electionTimeout` (2 s by default, plus a small random jitter), the tab becomes a **secondary** and adopts the primary's connection state. Otherwise it promotes itself to **primary** and opens the real socket.io connection.
3. **Events flow** — The primary forwards all socket events to secondaries via BroadcastChannel. Secondaries forward `emit` calls back to the primary.
4. **Heartbeats** — The primary broadcasts a heartbeat every `heartbeatInterval`. A secondary that goes `heartbeatTimeout` without one starts a fresh election.
5. **Failover** — A primary that is closing broadcasts `PRIMARY_LEAVING`, so the remaining tabs re-elect immediately instead of waiting out the heartbeat timeout. If it dies without warning, the heartbeat timeout covers it.
6. **Duplicate resolution** — If two tabs ever end up primary at once (both started in the same instant, or a message was lost), the one with the higher `tabId` keeps the socket and the other stands down. Heartbeats act as a backstop in case the claim itself is lost.

---

## Constructor

```typescript
new SocketIOProxy(channelId: string, url: string, options?: SocketIOProxyOptions)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `channelId` | `string` | **Required.** BroadcastChannel name (use the same value across tabs). Must be non-empty; choose a unique name per application to avoid cross-app interference on the same origin. |
| `url` | `string` | **Required.** The socket.io server URL. Must be a non-empty string. |
| `options` | `SocketIOProxyOptions` | Standard [socket.io-client options](https://socket.io/docs/v4/client-options/), plus the proxy options below |

### Proxy options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `debug` | `boolean` | `false` | Log state transitions and rejected messages to the console |
| `heartbeatInterval` | `number` | `3000` | How often the primary broadcasts a heartbeat, in ms |
| `heartbeatTimeout` | `number` | `10000` | How long a secondary waits without a heartbeat before re-electing, in ms |
| `ackTimeout` | `number` | `10000` | How long a secondary waits for an `emitWithAck` response from the primary, in ms |
| `electionTimeout` | `number` | `2000` | How long to wait for an existing primary to answer before self-promoting, in ms |
| `electionJitter` | `number` | `250` | Upper bound of the random delay added to `electionTimeout`, staggering simultaneous elections |
| `isolateByAuth` | `boolean` | `true` | Fold the connection identity into the channel name — see [Identity isolation](#identity-isolation) |
| `warnOnIdentityMismatch` | `boolean` | `true` | Warn when another tab on the same `channelId` describes its identity with a different set of keys — see [Catching a drifted identity](#catching-a-drifted-identity) |
| `autoConnect` | `boolean` | `true` | Passed through to socket.io, and seeds the channel's connection intent — see [Deferred connections](#deferred-connections) |

Every other option is passed straight through to `socket.io-client`.

---

## API Reference

### Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `initialize()` | `Promise<void>` | Negotiate primary/secondary role and set up listeners |
| `forcePrimary()` | `Promise<void>` | Take ownership of the socket for this tab, whatever the election says. See [Forcing promotion](#forcing-promotion) |
| `connectionUpdate()` | `void` | Push this tab's `connected` / `id` / `active` to the other tabs now, firing `connection_state_changed` on each. Primary only; a no-op on a secondary |
| `connect()` | `void` | Reconnect the socket (primary executes, secondary delegates) |
| `disconnect()` | `void` | Disconnect the socket |
| `closeChannel()` | `void` | Tear the proxy down: announce departure, disconnect if primary, reject pending acks and close the channel. Idempotent; the instance is unusable afterwards |

### Events

| Method | Returns | Description |
|--------|---------|-------------|
| `on(event, callback)` | `void` | Register event listener |
| `once(event, callback)` | `void` | Register one-time event listener |
| `off(event, callback?)` | `void` | Remove listener (or all listeners for event if no callback) |

Besides server events, a proxy emits two local-only events:
`SocketIOProxy.CONNECTION_STATE_EVENT` (`connection_state_changed`, see
[Reacting to connection changes](#reacting-to-connection-changes)) and
`SocketIOProxy.PROXY_ERROR_EVENT` (`proxy_error`, see
[Handling Internal Errors](#handling-internal-errors)).

Listeners behave identically whether the tab is primary or secondary, and they
survive a demotion. Socket lifecycle events (`connect`, `disconnect`,
`connect_error`) are forwarded to every tab, as are the Manager's reconnection
events (`reconnect`, `reconnect_attempt`, `reconnect_error`,
`reconnect_failed`) — socket.io emits those on the Manager, so without the
bridge a client that exhausts `reconnectionAttempts` never learns the
connection is gone for good.

`emit()` and `emitWithAck()` reject socket.io's reserved event names
(`connect`, `connect_error`, `disconnect`, `disconnecting`, `newListener`,
`removeListener`), matching `socket.io-client`.

### Emitting

| Method | Returns | Description |
|--------|---------|-------------|
| `emit(event, ...args)` | `void` | Emit event to server |
| `emitWithAck(event, ...args)` | `Promise<any>` | Emit and wait for server acknowledgement |
| `volatile()` | `this` | Mark next emission as volatile (chainable) |
| `timeout(ms)` | `this` | Set timeout for next emission (chainable) |
| `peers()` | `this` | Mark next `emit()` as peer-notifying — the server gets it once, and every *other* tab's `on()` listeners fire (chainable) |

`volatile()` and `timeout()` apply to whichever emission comes next — `emit()`
or `emitWithAck()` — and are consumed by it, even if that emission is rejected.
They work the same from a secondary tab: the flags travel with the message and
the primary applies them.

Errors from a user-driven call (`emit`, `emitWithAck`, `directChannelEmit`,
`sendMessageToPrimary`) throw at the call site — for example when an argument
cannot be structured-cloned across tabs. Background protocol traffic never
throws; it reports on `proxy_error` instead.

### State (Getters)

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether the socket is connected |
| `disconnected` | `boolean` | Whether the socket is disconnected |
| `active` | `boolean` | Whether the socket is active |
| `id` | `string \| undefined` | The socket session ID |
| `wantsConnection` | `boolean` | Whether the channel is *meant* to be connected — see [Deferred connections](#deferred-connections) |
| `io` | `any` | The underlying Manager (primary only, `null` for secondary) |
| `isPrimary` | `boolean` | Whether this tab holds the real connection |
| `channelName` | `string` | The effective BroadcastChannel name, including the identity suffix |

`SocketIOProxy.channelNameFor(channelId, url, options?)` is the static
equivalent — it resolves the same name without constructing a proxy, for
comparing two call sites in a test.

### Inter-Tab Messaging

| Method | Returns | Description |
|--------|---------|-------------|
| `sendMessageToPrimary(message)` | `void` | Send a custom `{ eventName, message }` payload to the primary tab. Called on the primary, it delivers locally |
| `onProxyMessage(eventName, subscriber)` | `() => void` | Subscribe to custom messages (returns unsubscribe function) |
| `onPrimaryCheck(callback)` | `() => void` | Subscribe to other tabs checking for a primary (returns unsubscribe function) |
| `directChannelEmit(event, ...args)` | `void` | Broadcast an EVENT to all tabs including this one, bypassing the socket |

---

## Identity isolation

Only the elected primary's options reach `io()`. If two tabs were signed in as
different users, the second would silently consume the first account's event
stream while believing it had passed its own credentials.

To prevent that, the effective BroadcastChannel name is
`"<channelId>#<fingerprint>"`, where the fingerprint covers `url`, `auth`,
`query`, `path` and `extraHeaders`. Tabs whose connection identity matches share
a socket exactly as before; tabs that differ land on separate channels and get
separate connections.

```typescript
const a = new SocketIOProxy("app", "https://server", { auth: { token: userA } });
const b = new SocketIOProxy("app", "https://server", { auth: { token: userB } });
a.channelName !== b.channelName; // true - no shared connection
```

Pass `isolateByAuth: false` to opt out and use `channelId` verbatim.

### Catching a drifted identity

This is the trap worth knowing about. Two call sites meant to be the *same*
user, differing by one key:

```typescript
// one service
new SocketIOProxy("rtc", url, { auth: { user, token, displayName } });
// the other — displayName omitted
new SocketIOProxy("rtc", url, { auth: { user, token } });
```

Those resolve to different channel names, so the two tabs never hear each other
and each opens its own socket. That is correct behaviour for two different
users, and a silent bug when it is one user described inconsistently — and
nothing inside the channel can detect it, because the two tabs are on different
channels by construction.

So each proxy announces its identity on a small diagnostics channel keyed by the
raw `channelId`, and warns when a peer's identity is described with a **different
set of keys**:

```
[SocketIOProxy] Another tab on channel "rtc" is using a different connection
identity, so the two are NOT sharing a socket (only there: auth.displayName). ...
```

Matching keys with different *values* — two genuinely different signed-in users —
never warn: that is what the isolation is for. Only key paths are broadcast,
never values. Pass `warnOnIdentityMismatch: false` to skip the channel entirely.

### Asserting it in a test

`SocketIOProxy.channelNameFor()` resolves a configuration to its channel name
without constructing anything, so the same mistake can fail your build instead:

```typescript
test("both services share one connection", () => {
  expect(SocketIOProxy.channelNameFor("rtc", url, primaryOptions))
    .toBe(SocketIOProxy.channelNameFor("rtc", url, popoutOptions));
});

test("different users stay isolated", () => {
  expect(SocketIOProxy.channelNameFor("rtc", url, { auth: { user: "a" } }))
    .not.toBe(SocketIOProxy.channelNameFor("rtc", url, { auth: { user: "b" } }));
});
```

> **Limitation.** A dynamic `auth` *callback* cannot be fingerprinted — only its
> source is visible, and that is identical across tabs even when the token it
> returns differs. If you authenticate with a callback, scope `channelId`
> yourself (for example, include the account id).

---

## Security notes

`SocketIOProxy` is a **coordination** mechanism, not a security boundary.

- **BroadcastChannel is same-origin.** Every message a tab posts is readable by
  any script running on the same origin, including forwarded socket events and
  `emitWithAck` responses.
- **The channel tag on each message is not authentication.** It is derived from
  the channel id so every tab agrees on it from construction; it keeps unrelated
  messages off the wire and stops protocol versions from mixing. Any script on
  the origin can derive it, use the shared socket, and emit on your behalf — as
  it could with a plain `socket.io-client` instance. Do not treat it as a trust
  boundary.
- **Identity isolation is a correctness guard, not an access control.** It stops
  tabs from *accidentally* sharing a connection across principals. It does not
  defend against hostile code already running on the origin.

---

## Advanced Usage

### Inter-Tab Communication (beyond socket events)

```typescript
// In any tab — send a custom message to the primary
proxy.sendMessageToPrimary({
  eventName: "sync-request",
  message: { key: "user-prefs" }
});

// In the primary tab — subscribe to custom messages
const unsubscribe = proxy.onProxyMessage("sync-request", (message) => {
  console.log("Secondary requested:", message);
  // Respond via directChannelEmit or socket emit
});

// Later
unsubscribe();
```

### Detecting Primary Role

```typescript
await proxy.initialize();

if (proxy.isPrimary) {
  console.log("This tab owns the socket connection");
}

// Get notified when secondary tabs check in
proxy.onPrimaryCheck(() => {
  console.log("A new tab connected to the channel");
});
```

### Reacting to connection changes

Socket lifecycle events (`connect`, `disconnect`, `connect_error`) reach every
tab, so most connection changes need nothing special. The gap is the **explicit
push** — when the primary's state changed in a way socket.io will not announce:

```typescript
// primary: the socket is not active, so disconnect() would emit nothing
if (proxy.active) { proxy.disconnect(); }
else { proxy.connectionUpdate(); }
```

Every secondary learns about it by subscribing rather than polling:

```typescript
proxy.on(SocketIOProxy.CONNECTION_STATE_EVENT, ({ connected, id, active, wantsConnection }) => {
  updateConnectionUi(connected);
});
```

The payload is a complete `{ connected, id, active, wantsConnection }` snapshot,
and the getters already agree with it by the time your listener runs. It fires on every push a
secondary applies, including one that changes nothing — the primary sends these
deliberately, so you can rely on being told. The primary does not fire it for
its own pushes: it is the originator, and already has `connect`/`disconnect`.

### Deferred connections

Pass `autoConnect: false` when the connection should wait for something — a
user who is signed in but marked offline, a view that has not been opened yet:

```typescript
const proxy = new SocketIOProxy("app", url, { auth, autoConnect: false });
await proxy.initialize();
// no socket yet, in any tab

proxy.connect();     // now, and from here on, the channel is meant to be up
```

The important part is what happens on **failover**. The tab that gets promoted
is rarely the tab you called `connect()` on, so the proxy carries the *intent*
rather than the call:

| | Result on the tab promoted next |
|---|---|
| Some tab called `connect()` | Its socket opens, with no consumer involvement |
| Nobody has called `connect()` | Its socket stays closed — `autoConnect: false` is honored |
| Some tab called `disconnect()` | Its socket stays closed |

Intent is channel-wide, so a new tab opened with the default `autoConnect: true`
does **not** drag a deliberately-offline channel online: it adopts the channel's
intent when a primary answers its election.

`wantsConnection` exposes it, which is what separates a deliberate offline state
from a broken one:

```typescript
if (!proxy.connected && proxy.wantsConnection) {
  showReconnectingBanner();     // should be up, is not
}
```

After `forcePrimary()`, a channel that was connected stays connected without a
following `connect()`. The socket is *opening* when the promise resolves rather
than already open — as with any socket.io connect — so emits made right after
are buffered until it lands, exactly as they are on a fresh `io()`.

### Forcing promotion

Sometimes a particular tab must own the connection — a pop-out taking over an
in-progress call, a mobile view that should not ride another tab's socket, or a
"make this tab primary" control.

```typescript
await proxy.forcePrimary();
// this tab now holds the socket; the previous primary is a normal secondary
```

The previous primary stands down first and answers once it has, so the handover
never leaves two sockets open — there is a brief window with no primary, which
is the safe direction to fail. If no primary answers, this tab promotes after
`electionTimeout`. Calling it on the existing primary resolves immediately, and
listeners registered before the call keep working.

### Notifying sibling tabs

`emit()` reaches the server. `peers().emit()` reaches the server **and** every
other tab's ordinary `on()` listeners, in a single channel message:

```typescript
// in the pop-out
proxy.peers().emit("leave-room", roomId);

// in the main tab
proxy.on("leave-room", (roomId) => clearCallState(roomId));
```

The emitting tab does not receive its own event. Use `directChannelEmit()` when
you want to notify the other tabs *without* sending to the server at all.

### Handling Internal Errors

Errors the proxy catches — a listener that throws, a malformed message from
another tab — are reported on a local `proxy_error` event rather than escaping
into the BroadcastChannel callback where nothing could catch them.

```typescript
import SocketIOProxy from "@mdaemon/socket.io-client-proxy";

proxy.on(SocketIOProxy.PROXY_ERROR_EVENT, (error, context) => {
  console.warn("proxy error while", context, error);
});
```

### Tuning Failover

```typescript
const proxy = new SocketIOProxy("my-app-channel", "https://my-server.com", {
  electionTimeout: 1000,   // promote faster when no primary answers
  heartbeatInterval: 2000, // primary announces itself more often
  heartbeatTimeout: 6000,  // secondaries give up on a silent primary sooner
});
```

### Direct Channel Broadcasting

```typescript
// Emit an event to all tabs - including this one - without going through the
// socket server.
proxy.directChannelEmit("local-update", { cached: true, data: payload });
```

---

## Running the tests

```bash
npm test
```

Use the script rather than a bare `npx jest`. It runs jest under
`--stack-size=2000`, and without that roughly two dozen specs fail with
`RangeError: Maximum call stack size exceeded` — always at an
`expect().toThrow()`, always with `source-map`'s `doQuickSort` on the stack.
That is jest formatting a failure against V8's default stack budget, not the
library misbehaving.

---

## License

Published under the [LGPL-3.0-or-later license](https://github.com/mdaemon-technologies/socket.io-client-proxy/blob/main/LICENSE "LGPL-3.0-or-later").

See [CHANGELOG.md](CHANGELOG.md) for release history.

In active use in MDaemon's Webmail.

Published by
**MDaemon Technologies, Ltd.**
**Simple Secure Email**
[https://www.mdaemon.com](https://www.mdaemon.com)
