[![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmdaemon-technologies%2Fsocket-client-proxy%2Fmain%2Fpackage.json&query=%24.version&prefix=v&label=npm&color=blue)](https://www.npmjs.com/package/@mdaemon/socket.io-client-proxy) [![Static Badge](https://img.shields.io/badge/node-v18%2B-blue?style=flat&label=node&color=blue)](https://nodejs.org) [![install size](https://packagephobia.com/badge?p=@mdaemon/socket.io-client-proxy)](https://packagephobia.com/result?p=@mdaemon/socket.io-client-proxy) [![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmdaemon-technologies%2Fsocket-client-proxy%2Fmain%2Fpackage.json&query=%24.license&prefix=v&label=license&color=green)](https://github.com/mdaemon-technologies/socket-client-proxy/blob/main/LICENSE)

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

### Node CommonJS
```javascript
const SocketIOProxy = require("@mdaemon/socket.io-client-proxy/dist/socket-io-proxy.umd.js");
```

### Node ES Modules
```javascript
import SocketIOProxy from "@mdaemon/socket.io-client-proxy/dist/socket-io-proxy.mjs";
```

### Browser
```html
<script type="text/javascript" src="/path_to_modules/dist/socket-io-proxy.umd.js"></script>
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

1. **Construction** — Each tab creates a `SocketIOProxy` instance with the same `channelId`.
2. **`initialize()`** — The tab broadcasts a `PRIMARY_CHECK` message. If an existing primary responds within 2 seconds, the tab becomes a **secondary**. Otherwise, it promotes itself to **primary** and opens the real socket.io connection.
3. **Events flow** — The primary forwards all socket events to secondaries via BroadcastChannel. Secondaries forward `emit` calls back to the primary.
4. **Failover** — When a new tab calls `initialize()` and no primary responds, it takes over.

---

## Constructor

```typescript
new SocketIOProxy(channelId: string, url: string, options?: any)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `channelId` | `string` | **Required.** BroadcastChannel name (use the same value across tabs). Must be non-empty; choose a unique name per application to avoid cross-app interference on the same origin. |
| `url` | `string` | The socket.io server URL |
| `options` | `any` | Standard [socket.io-client options](https://socket.io/docs/v4/client-options/) |

---

## API Reference

### Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `initialize()` | `Promise<void>` | Negotiate primary/secondary role and set up listeners |
| `connect()` | `void` | Reconnect the socket (primary executes, secondary delegates) |
| `disconnect()` | `void` | Disconnect the socket |
| `closeChannel()` | `void` | Close the BroadcastChannel |

### Events

| Method | Returns | Description |
|--------|---------|-------------|
| `on(event, callback)` | `void` | Register event listener |
| `once(event, callback)` | `void` | Register one-time event listener |
| `off(event, callback?)` | `void` | Remove listener (or all listeners for event if no callback) |

### Emitting

| Method | Returns | Description |
|--------|---------|-------------|
| `emit(event, ...args)` | `void` | Emit event to server |
| `emitWithAck(event, ...args)` | `Promise<any>` | Emit and wait for server acknowledgement |
| `volatile()` | `this` | Mark next emission as volatile (chainable) |
| `timeout(ms)` | `this` | Set timeout for next emission (chainable) |

### State (Getters)

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Whether the socket is connected |
| `disconnected` | `boolean` | Whether the socket is disconnected |
| `active` | `boolean` | Whether the socket is active |
| `id` | `string \| undefined` | The socket session ID |
| `io` | `any` | The underlying Manager (primary only, `null` for secondary) |
| `isPrimary` | `boolean` | Whether this tab holds the real connection |

### Inter-Tab Messaging

| Method | Returns | Description |
|--------|---------|-------------|
| `sendMessageToPrimary(message)` | `void` | Send custom message to the primary tab |
| `onProxyMessage(eventName, subscriber)` | `() => void` | Subscribe to custom messages (returns unsubscribe function) |
| `onPrimaryCheck(callback)` | `void` | Register callback for when other tabs check for primary |
| `directChannelEmit(event, ...args)` | `void` | Broadcast an EVENT directly to all tabs (bypasses socket) |

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

### Direct Channel Broadcasting

```typescript
// Emit an event to all tabs without going through the socket server
proxy.directChannelEmit("local-update", { cached: true, data: payload });
```

---

## License

Published under the [LGPL-3.0-or-later license](https://github.com/mdaemon-technologies/socket-client-proxy/blob/main/LICENSE "LGPL-3.0-or-later").

Published by
**MDaemon Technologies, Ltd.**
**Simple Secure Email**
[https://www.mdaemon.com](https://www.mdaemon.com)
