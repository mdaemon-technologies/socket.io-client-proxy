import { jest } from '@jest/globals';
import { io } from 'socket.io-client';
import SocketIOProxy from '../../socket-io-proxy';

/**
 * Shared test harness.
 *
 * NOTE: @mdaemon/validate is deliberately NOT mocked anywhere in this suite. A
 * hand-rolled stand-in previously accepted `undefined` for non-required string
 * properties while the real library rejects it, which hid a bug where every
 * SOCKET_ID_UPDATE sent after a disconnect was silently discarded.
 *
 * NOTE: `npm test` runs jest with `--stack-size=2000`. jest's own frames are
 * large, and the layered fake timers, spies and module mocks below put
 * `expect().toThrow()` close enough to V8's default budget that it
 * intermittently raised "Maximum call stack size exceeded" — deterministically
 * so under `--stack-size=800`, on the committed 1.1.0 tree as well as this one.
 * The bump restores headroom; it is not hiding a recursion bug.
 *
 * NOTE: the specs are split across several files on purpose. Registering
 * roughly ninety or more tests in a single file overflows the stack the same
 * way, and even `expect(1).toBe(1)` then fails.
 */

export type AnySocket = any;

/**
 * @param overrides fields to force onto the socket, applied last.
 * @param opts the options `io()` was called with. `autoConnect: false` produces
 *   a socket that starts closed, and `connect()` / `disconnect()` really move
 *   `connected` / `active` / `id` — without that a test cannot tell a socket
 *   that was opened from one that never was.
 */
export function makeMockSocket(
  overrides: Record<string, any> = {},
  opts: Record<string, any> = {},
): AnySocket {
  const open = opts.autoConnect !== false;
  const id = overrides.id ?? 'test-socket-id';

  const socket: AnySocket = {
    emit: jest.fn(),
    emitWithAck: jest.fn<any>().mockResolvedValue(undefined),
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    onAny: jest.fn(),
    volatile: {},
    timeout: jest.fn(),
    id: open ? id : undefined,
    connected: open,
    active: open,
    io: { on: jest.fn(), off: jest.fn() },
  };

  socket.connect = jest.fn(() => {
    socket.connected = true;
    socket.active = true;
    socket.id = id;
    return socket;
  });
  socket.disconnect = jest.fn(() => {
    socket.connected = false;
    socket.active = false;
    socket.id = undefined;
    return socket;
  });

  // `id` is consumed above; re-applying it here would reopen a closed socket.
  const { id: _id, ...rest } = overrides;
  return Object.assign(socket, rest);
}

export function makeMockChannel() {
  return {
    postMessage: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    close: jest.fn(),
    onmessage: null as any,
  };
}

export interface Harness {
  mockSocket: AnySocket;
  mockChannel: ReturnType<typeof makeMockChannel>;
  /** The identity-diagnostics channel, kept separate from the main one. */
  lobbyChannel: ReturnType<typeof makeMockChannel>;
  /** console.warn, spied so identity diagnostics do not litter the output. */
  warn: any;
}

/** Must match IDENTITY_LOBBY_SUFFIX in the proxy. */
export const IDENTITY_LOBBY_SUFFIX = '::sioproxy-identity';

/**
 * Installs fake timers, a deterministic jitter source, a counter-based crypto
 * mock and single-channel BroadcastChannel/socket stubs.
 *
 * The crypto mock is counter-based so each proxy gets a DISTINCT tabId. A
 * previous constant mock gave every instance the same tabId, which made the
 * duplicate-primary tie-break unreachable in tests.
 */
/**
 * Window listeners added while a test ran, so they can be unwound afterwards.
 *
 * A proxy that becomes primary registers beforeunload/pagehide/pageshow and only
 * drops them on demotion or closeChannel(). Tests routinely leave proxies open,
 * so without this every test inherits the listeners of every test before it and
 * the suite becomes order-dependent.
 */
let trackedListeners: [string, any, any][] = [];
let listenerTrackingInstalled = false;

function trackWindowListeners(): void {
  if (listenerTrackingInstalled) {
    return;
  }
  listenerTrackingInstalled = true;
  const realAdd = window.addEventListener.bind(window);
  (window as any).addEventListener = (type: string, cb: any, opts?: any) => {
    trackedListeners.push([type, cb, opts]);
    return realAdd(type, cb, opts);
  };
}

export function installFakes(): Harness {
  jest.useFakeTimers();
  trackWindowListeners();
  trackedListeners = [];

  // Election jitter is randomised; pin it to zero so timings are exact.
  jest.spyOn(Math, 'random').mockReturnValue(0);

  let idCounter = 0;
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues: (arr: Uint8Array) => {
        const seed = ++idCounter;
        for (let i = 0; i < arr.length; i++) arr[i] = (seed * 7 + i) & 0xff;
        return arr;
      },
    },
    writable: true,
    configurable: true,
  });

  const mockSocket = makeMockSocket();
  // mockReset clears call history carried over from the previous test in this
  // file; jest.restoreAllMocks() does not reset module mocks.
  (io as jest.Mock).mockReset();
  // Always the same socket, so `h.mockSocket` stays the one the proxy holds —
  // but reconfigured per call, so a proxy built with `autoConnect: false` gets
  // a socket that really starts closed.
  (io as jest.Mock).mockImplementation((...args: unknown[]) => {
    const open = (args[1] as Record<string, any> | undefined)?.autoConnect !== false;
    mockSocket.connected = open;
    mockSocket.active = open;
    mockSocket.id = open ? 'test-socket-id' : undefined;
    return mockSocket;
  });

  // A proxy opens two channels: the main one and the identity lobby. They must
  // be distinct here, or the lobby's onmessage would clobber the main handler.
  const mockChannel = makeMockChannel();
  const lobbyChannel = makeMockChannel();
  globalThis.BroadcastChannel = jest.fn().mockImplementation((...args: unknown[]) =>
    String(args[0] ?? '').endsWith(IDENTITY_LOBBY_SUFFIX) ? lobbyChannel : mockChannel
  ) as unknown as typeof BroadcastChannel;

  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  return { mockSocket, mockChannel, lobbyChannel, warn };
}

export function restoreFakes(): void {
  jest.useRealTimers();
  jest.restoreAllMocks();

  // Drop anything a proxy the test left open registered on window.
  trackedListeners.forEach(([type, cb, opts]) => window.removeEventListener(type, cb, opts));
  trackedListeners = [];
}

// --- introspection -----------------------------------------------------------

/** The proxy derives its channel tag from the channel id; read it off the instance. */
export function getToken(proxy: SocketIOProxy): string {
  return (proxy as any).token;
}

export function tabIdOf(proxy: SocketIOProxy): string {
  return (proxy as any).tabId;
}

export function listenersFor(proxy: SocketIOProxy, event: string): any[] | undefined {
  return (proxy as any).listeners.get(event);
}

/** Retrieves a lifecycle handler the primary registered on the socket. */
export function socketHandler(socket: AnySocket, event: string): (...args: any[]) => void {
  const call = socket.on.mock.calls.find((c: any[]) => c[0] === event);
  if (!call) throw new Error(`no handler registered for "${event}"`);
  return call[1];
}

// --- message builders --------------------------------------------------------

/** Wraps a payload with the correct channel tag, as a peer tab would send it. */
export function msg(proxy: SocketIOProxy, payload: any) {
  return { data: { ...payload, token: getToken(proxy) } };
}

/** A well-formed PRIMARY_ALIVE from some other tab. */
export function primaryAlive(proxy: SocketIOProxy, overrides: Record<string, any> = {}) {
  return msg(proxy, {
    type: 'PRIMARY_ALIVE',
    data: {
      tabId: 'ff'.repeat(24),
      epoch: 1,
      connected: false,
      active: false,
      id: '',
      wantsConnection: true,
      ...overrides,
    },
  });
}

/** A well-formed PRIMARY_CLAIM from some other tab. */
export function primaryClaim(proxy: SocketIOProxy, overrides: Record<string, any> = {}) {
  return msg(proxy, {
    type: 'PRIMARY_CLAIM',
    data: { tabId: 'ff'.repeat(24), epoch: 1, ...overrides },
  });
}

/** A well-formed HEARTBEAT from some other tab. */
export function heartbeat(proxy: SocketIOProxy, overrides: Record<string, any> = {}) {
  return msg(proxy, {
    type: 'HEARTBEAT',
    data: { tabId: 'ff'.repeat(24), epoch: 1, ...overrides },
  });
}

/** A well-formed CONNECTION_STATE push from the primary. */
export function connectionState(proxy: SocketIOProxy, overrides: Record<string, any> = {}) {
  return msg(proxy, {
    type: 'CONNECTION_STATE',
    data: {
      connected: true, active: true, id: 'test-socket-id', wantsConnection: true, ...overrides,
    },
  });
}

/** The epoch a proxy currently holds; 0 when it is not the primary. */
export function epochOf(proxy: SocketIOProxy): number {
  return (proxy as any).epoch;
}

/** Answers the proxy's PRIMARY_CHECK so it settles as a secondary. */
export function respondAsPrimary(
  channel: ReturnType<typeof makeMockChannel>,
  proxy: SocketIOProxy,
  overrides: Record<string, any> = {},
) {
  channel.postMessage.mockImplementation((posted: any) => {
    if (posted.type === 'PRIMARY_CHECK' && channel.onmessage) {
      channel.onmessage(primaryAlive(proxy, overrides));
    }
  });
}

/** Drives a proxy to primary by letting the election time out. */
export async function electAsPrimary(proxy: SocketIOProxy) {
  const promise = proxy.initialize();
  jest.advanceTimersByTime(2000);
  await promise;
}

/** Settles a proxy as a secondary of a simulated primary. */
export async function joinAsSecondary(
  channel: ReturnType<typeof makeMockChannel>,
  proxy: SocketIOProxy,
  overrides: Record<string, any> = {},
) {
  respondAsPrimary(channel, proxy, overrides);
  await proxy.initialize();
  // Stop auto-answering, and drop handshake traffic, so later assertions see
  // only the messages the test itself provokes.
  channel.postMessage.mockImplementation(() => {});
  channel.postMessage.mockClear();
}

// --- multi-tab bus -----------------------------------------------------------

/**
 * An in-memory BroadcastChannel implementation that actually routes messages
 * between instances sharing a name (never echoing to the sender), so multi-tab
 * behaviour — elections, split brain, failover — can be exercised for real.
 */
export class ChannelBus {
  public channels: FakeChannel[] = [];
  public paused = false;
  public queue: { from: FakeChannel; data: any }[] = [];

  register(channel: FakeChannel) {
    this.channels.push(channel);
  }

  unregister(channel: FakeChannel) {
    this.channels = this.channels.filter(c => c !== channel);
  }

  deliver(from: FakeChannel, data: any) {
    if (this.paused) {
      this.queue.push({ from, data });
      return;
    }
    this.dispatch(from, data);
  }

  private dispatch(from: FakeChannel, data: any) {
    // Real BroadcastChannel semantics: structured clone, so tests cannot share
    // references AND a payload the proxy cannot actually send fails here too.
    const cloned = structuredClone(data);
    this.channels
      .filter(c => c !== from && c.name === from.name && !c.closed)
      .forEach(c => c.receive(cloned));
  }

  /** Buffers traffic so several tabs can reach a decision before they see each other. */
  pause() {
    this.paused = true;
  }

  flush() {
    this.paused = false;
    const pending = this.queue;
    this.queue = [];
    pending.forEach(({ from, data }) => this.dispatch(from, data));
  }

  /** Drops buffered traffic entirely, simulating messages lost in transit. */
  discard() {
    this.queue = [];
    this.paused = false;
  }
}

export class FakeChannel {
  public onmessage: ((event: any) => void) | null = null;
  public closed = false;
  private listeners: ((event: any) => void)[] = [];

  constructor(public name: string, private bus: ChannelBus) {
    bus.register(this);
  }

  postMessage(data: any) {
    if (this.closed) {
      throw new Error('Channel is closed');
    }
    this.bus.deliver(this, data);
  }

  receive(data: any) {
    const event = { data };
    if (this.onmessage) this.onmessage(event);
    this.listeners.slice().forEach(l => l(event));
  }

  addEventListener(_type: string, handler: (event: any) => void) {
    this.listeners.push(handler);
  }

  removeEventListener(_type: string, handler: (event: any) => void) {
    this.listeners = this.listeners.filter(l => l !== handler);
  }

  close() {
    this.closed = true;
    this.bus.unregister(this);
  }
}

export interface BusHarness {
  bus: ChannelBus;
  sockets: AnySocket[];
}

/** Swaps the single-channel stubs for a bus that really routes between tabs. */
export function installBus(): BusHarness {
  const bus = new ChannelBus();
  const sockets: AnySocket[] = [];

  globalThis.BroadcastChannel = jest.fn().mockImplementation(
    (...args: unknown[]) => new FakeChannel(args[0] as string, bus)
  ) as unknown as typeof BroadcastChannel;

  (io as jest.Mock).mockImplementation((...args: unknown[]) => {
    const socket = makeMockSocket(
      { id: `socket-${sockets.length + 1}` },
      (args[1] as Record<string, any>) ?? {},
    );
    sockets.push(socket);
    return socket;
  });

  return { bus, sockets };
}
