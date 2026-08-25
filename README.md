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

Every other option is passed straight through to `socket.io-client`.

---

## API Reference

### Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `initialize()` | `Promise<void>` | Negotiate primary/secondary role and set up listeners |
| `connect()` | `void` | Reconnect the socket (primary executes, secondary delegates) |
| `disconnect()` | `void` | Disconnect the socket |
| `closeChannel()` | `void` | Tear the proxy down: announce departure, disconnect if primary, reject pending acks and close the channel. Idempotent; the instance is unusable afterwards |

### Events

| Method | Returns | Description |
|--------|---------|-------------|
| `on(event, callback)` | `void` | Register event listener |
| `once(event, callback)` | `void` | Register one-time event listener |
| `off(event, callback?)` | `void` | Remove listener (or all listeners for event if no callback) |

Listeners behave identically whether the tab is primary or secondary, and they
survive a demotion. Socket lifecycle events (`connect`, `disconnect`,
`connect_error`) are forwarded to every tab.

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
| `io` | `any` | The underlying Manager (primary only, `null` for secondary) |
| `isPrimary` | `boolean` | Whether this tab holds the real connection |
| `channelName` | `string` | The effective BroadcastChannel name, including the identity suffix |

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

## License

Published under the [LGPL-3.0-or-later license](https://github.com/mdaemon-technologies/socket.io-client-proxy/blob/main/LICENSE "LGPL-3.0-or-later").

See [CHANGELOG.md](CHANGELOG.md) for release history.

Published by
**MDaemon Technologies, Ltd.**
**Simple Secure Email**
[https://www.mdaemon.com](https://www.mdaemon.com)
