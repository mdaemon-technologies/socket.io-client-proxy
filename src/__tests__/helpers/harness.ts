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
 * NOTE: the specs are split across several files on purpose. Registering
 * roughly ninety or more tests in a single file overflows the stack in this
 * jest/jsdom environment, and even `expect(1).toBe(1)` then fails.
 */

export type AnySocket = any;

export function makeMockSocket(overrides: Record<string, any> = {}): AnySocket {
  return {
    emit: jest.fn(),
    emitWithAck: jest.fn<any>().mockResolvedValue(undefined),
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    disconnect: jest.fn(),
    connect: jest.fn(),
    onAny: jest.fn(),
    volatile: {},
    timeout: jest.fn(),
    id: 'test-socket-id',
    connected: true,
    active: true,
    io: { on: jest.fn() },
    ...overrides,
  };
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
}

/**
 * Installs fake timers, a deterministic jitter source, a counter-based crypto
 * mock and single-channel BroadcastChannel/socket stubs.
 *
 * The crypto mock is counter-based so each proxy gets a DISTINCT tabId. A
 * previous constant mock gave every instance the same tabId, which made the
 * duplicate-primary tie-break unreachable in tests.
 */
export function installFakes(): Harness {
  jest.useFakeTimers();

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
  (io as jest.Mock).mockReturnValue(mockSocket);

  const mockChannel = makeMockChannel();
  globalThis.BroadcastChannel = jest.fn()
    .mockImplementation(() => mockChannel) as unknown as typeof BroadcastChannel;

  return { mockSocket, mockChannel };
}

export function restoreFakes(): void {
  jest.useRealTimers();
  jest.restoreAllMocks();
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
    data: { tabId: 'ff'.repeat(24), connected: false, active: false, id: '', ...overrides },
  });
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

  (io as jest.Mock).mockImplementation(() => {
    const socket = makeMockSocket({ id: `socket-${sockets.length + 1}` });
    sockets.push(socket);
    return socket;
  });

  return { bus, sockets };
}
