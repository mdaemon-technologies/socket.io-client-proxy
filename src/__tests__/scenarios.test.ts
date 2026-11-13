import { vi, describe, test, expect, type Mock } from 'vitest';
import { io } from 'socket.io-client';
import SocketIOProxy from '../socket-io-proxy';
import { deriveToken } from '../protocol/messages';
import { installFakes, restoreFakes, ChannelBus, FakeChannel } from './helpers/harness';

vi.mock('socket.io-client');

/**
 * Scripted multi-tab sessions, recorded as a trace of everything observable
 * from outside the proxy: every message a tab puts on the channel, every call
 * a primary makes on its socket, every listener and subscriber call, how each
 * promise settles, what each call throws, the getters and the number of
 * pending timers. Each line carries the fake clock.
 *
 * The snapshots are the reference. They were recorded when the class was
 * split into modules, after the original single-class implementation (1.2.2,
 * commit c5e0e7c) and the split produced identical traces for every
 * scenario. A snapshot that changes is a behaviour change: review the diff
 * before updating it. To repeat the comparison against 1.2.2, save
 * `git show c5e0e7c:src/socket-io-proxy.ts` under `src/__tests__/` and run
 * each scenario against both classes with `toEqual`.
 *
 * The sockets behave like socket.io's: `io()` opens them unless
 * `autoConnect` is false, `connect` completes 5 ms later, and `disconnect()`
 * fires the `disconnect` event synchronously when the socket was connected.
 */

type ProxyClass = new (channelId: string, url: string, options?: any) => any;
type Script = (s: Scenario) => Promise<void>;

/** Events every tab records when its listeners receive them. */
const WATCHED = [
  'news', 'chat', 'direct', 'boom', '__proto__', 'toString',
  'connect', 'disconnect', 'connect_error',
  'reconnect', 'reconnect_attempt', 'reconnect_error', 'reconnect_failed',
  'proxy_error', 'connection_state_changed',
];

function fmt(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) => {
    if (v instanceof Error) return `Error(${v.message})`;
    if (v === undefined) return '<undefined>';
    if (typeof v === 'function') return '<fn>';
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    return v;
  });
  return text ?? String(value);
}

function describeMessage(data: any): string {
  if (data && typeof data === 'object' && 'type' in data) {
    return `${data.type} ${fmt(data.data)}`;
  }
  if (data && typeof data === 'object' && 'kind' in data) {
    return `lobby:${data.kind} ${fmt({ tabId: data.tabId, keys: data.keys })}`;
  }
  return `raw ${fmt(data)}`;
}

interface StubSocket {
  socket: any;
  any: ((...args: any[]) => void)[];
  handlers: Map<string, ((...args: any[]) => void)[]>;
  manager: Map<string, ((...args: any[]) => void)[]>;
}

class Scenario {
  readonly log: string[] = [];
  readonly bus = new ChannelBus();
  readonly tabs: any[] = [];
  private readonly sockets: StubSocket[] = [];
  private readonly owner = new Map<FakeChannel, string>();
  private constructing: string | null = null;
  private readonly start = Date.now();

  constructor(readonly Impl: ProxyClass) {
    const deliver = this.bus.deliver.bind(this.bus);
    this.bus.deliver = (from: FakeChannel, data: any) => {
      this.record(`${this.ownerOf(from)} > ${describeMessage(data)}`);
      deliver(from, data);
    };
    const bus = this.bus;
    globalThis.BroadcastChannel = vi.fn().mockImplementation(function (name: string) {
      return new FakeChannel(name, bus);
    }) as unknown as typeof BroadcastChannel;
    (io as Mock).mockImplementation((url: string, options: any) => this.makeSocket(url, options));
    // The page listeners a tab holds are observable too: a leaked one keeps
    // the tab reacting to page events it should have stopped hearing.
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: any, options?: any) => {
      this.record(`window +${type}`);
      add(type, listener, options);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, listener: any, options?: any) => {
      this.record(`window -${type}`);
      remove(type, listener, options);
    });
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      this.record(`warn ${String(message)}`);
    });
  }

  record(line: string): void {
    this.log.push(`@${Date.now() - this.start} ${line}`);
  }

  // --- tabs ---------------------------------------------------------------------

  tab(channelId = 'app', options: Record<string, unknown> = {}): any {
    const index = this.tabs.length;
    const label = `T${index}`;
    const from = this.bus.opened.length;
    this.constructing = label;
    let proxy: any;
    try {
      proxy = new this.Impl(channelId, 'ws://server', options);
    }
    finally {
      this.constructing = null;
    }
    this.bus.opened.slice(from).forEach((c) => this.owner.set(c, this.channelLabel(label, c)));

    WATCHED.forEach((event) => {
      proxy.on(event, (...args: unknown[]) => {
        const shown = event === 'proxy_error' ? [args[0], args[1]] : args;
        this.record(`${label} on ${event} ${fmt(shown)}`);
      });
    });
    proxy.onProxyMessage('topic', (message: unknown) => this.record(`${label} proxyMessage topic ${fmt(message)}`));
    proxy.onPrimaryCheck(() => this.record(`${label} primaryCheck`));
    this.tabs.push(proxy);
    this.record(`${label} created on ${proxy.channelName}`);
    return proxy;
  }

  async init(index: number): Promise<void> {
    this.track(`T${index}.initialize`, this.tabs[index].initialize());
    await this.settle();
  }

  /** Initializes a tab and lets its election time out, so it promotes itself. */
  async elect(index: number): Promise<void> {
    this.track(`T${index}.initialize`, this.tabs[index].initialize());
    await this.advance(2000);
    await this.advance(10);
  }

  /** The tab dies without a word: its channels close. */
  kill(index: number): void {
    this.record(`T${index} killed`);
    this.owner.forEach((label, channel) => {
      if (label === `T${index}` || label === `T${index}~lobby`) {
        channel.close();
      }
    });
  }

  // --- time and calls -------------------------------------------------------------

  async advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  async settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  track(label: string, promise: Promise<unknown>): void {
    promise.then(
      (value) => this.record(`${label} resolved ${fmt(value)}`),
      (error) => this.record(`${label} rejected ${error instanceof Error ? error.message : fmt(error)}`),
    );
  }

  call(label: string, fn: () => unknown): void {
    try {
      const result = fn();
      if (result instanceof Promise) {
        this.record(`${label} -> promise`);
        this.track(label, result);
      }
      else {
        this.record(`${label} -> ${result === undefined ? 'ok' : typeof result === 'object' ? 'object' : fmt(result)}`);
      }
    }
    catch (error) {
      this.record(`${label} threw ${error instanceof Error ? error.message : fmt(error)}`);
    }
  }

  snapshot(label: string): void {
    this.record(`-- ${label} (timers=${vi.getTimerCount()})`);
    this.tabs.forEach((p, i) => {
      this.record(
        `   T${i} primary=${p.isPrimary} connected=${p.connected} disconnected=${p.disconnected} `
        + `active=${p.active} id=${p.id} wants=${p.wantsConnection} io=${p.io ? 'manager' : String(p.io)}`,
      );
    });
  }

  page(event: string): void {
    this.record(`window ${event}`);
    window.dispatchEvent(new Event(event));
  }

  pause(): void {
    this.record('bus paused');
    this.bus.pause();
  }

  flush(): void {
    this.record('bus flushed');
    this.bus.flush();
  }

  /** Posts raw data on a channel from a script that is not a proxy. */
  inject(channelName: string, data: unknown): void {
    const intruder = new FakeChannel(channelName, this.bus);
    this.owner.set(intruder, 'X');
    try {
      intruder.postMessage(data);
    }
    finally {
      intruder.close();
    }
  }

  // --- the server side of the sockets ---------------------------------------------

  server(index: number, event: string, ...args: unknown[]): void {
    this.record(`S${index} <server ${event} ${fmt(args)}`);
    this.sockets[index].any.slice().forEach((h) => h(event, ...args));
  }

  lifecycle(index: number, event: string, ...args: unknown[]): void {
    this.record(`S${index} <lifecycle ${event}`);
    (this.sockets[index].handlers.get(event) ?? []).slice().forEach((h) => h(...args));
  }

  managerEvent(index: number, event: string, ...args: unknown[]): void {
    const handlers = this.sockets[index].manager.get(event) ?? [];
    this.record(`S${index} <manager ${event} (${handlers.length} listening)`);
    handlers.slice().forEach((h) => h(...args));
  }

  // --- internals ----------------------------------------------------------------

  private channelLabel(tab: string, channel: FakeChannel): string {
    return channel.name.includes('::') ? `${tab}~lobby` : tab;
  }

  private ownerOf(channel: FakeChannel): string {
    return this.owner.get(channel)
      ?? (this.constructing ? this.channelLabel(this.constructing, channel) : '?');
  }

  private makeSocket(url: string, options: any): any {
    const label = `S${this.sockets.length}`;
    const rec = (line: string) => this.record(`${label} ${line}`);
    rec(`io(${url}, ${fmt(options)})`);

    const stub: StubSocket = { socket: null, any: [], handlers: new Map(), manager: new Map() };
    const add = (map: Map<string, any[]>, event: string, handler: any) => {
      map.set(event, [...(map.get(event) ?? []), handler]);
    };
    const fire = (event: string, ...args: unknown[]) => {
      (stub.handlers.get(event) ?? []).slice().forEach((h) => h(...args));
    };

    let connecting: ReturnType<typeof setTimeout> | null = null;
    const manager = {
      on: (event: string, handler: any) => add(stub.manager, event, handler),
      off: (event: string, handler: any) => {
        rec(`manager.off ${event}`);
        stub.manager.set(event, (stub.manager.get(event) ?? []).filter((h) => h !== handler));
      },
    };

    const emitter = (flags: string): any => ({
      emit: (event: string, ...args: unknown[]) => {
        rec(`emit${flags} ${event} ${fmt(args)}`);
        return socket;
      },
      emitWithAck: (event: string, ...args: unknown[]) => {
        rec(`emitWithAck${flags} ${event} ${fmt(args)}`);
        if (event === 'ack-ok') return Promise.resolve({ echoed: args });
        if (event === 'ack-fail') return Promise.reject(new Error('server refused'));
        if (event === 'ack-slow') return new Promise(() => {});
        return Promise.resolve('ack');
      },
      timeout: (ms: number) => emitter(`${flags}[timeout ${ms}]`),
      get volatile() {
        return emitter(`${flags}[volatile]`);
      },
    });
    const base = emitter('');

    const socket: any = {
      id: undefined,
      connected: false,
      active: false,
      io: manager,
      onAny: (handler: any) => stub.any.push(handler),
      on: (event: string, handler: any) => add(stub.handlers, event, handler),
      emit: base.emit,
      emitWithAck: base.emitWithAck,
      timeout: base.timeout,
      connect: () => {
        rec('connect()');
        open();
        return socket;
      },
      disconnect: () => {
        rec('disconnect()');
        const wasConnected = socket.connected;
        if (connecting) {
          clearTimeout(connecting);
          connecting = null;
        }
        socket.connected = false;
        socket.active = false;
        socket.id = undefined;
        if (wasConnected) {
          fire('disconnect', 'io client disconnect');
        }
        return socket;
      },
    };
    Object.defineProperty(socket, 'volatile', { get: () => emitter('[volatile]') });

    const open = () => {
      if (socket.active) return;
      socket.active = true;
      connecting = setTimeout(() => {
        connecting = null;
        socket.connected = true;
        socket.id = `${label}-id`;
        rec('connected');
        fire('connect');
      }, 5);
    };

    stub.socket = socket;
    this.sockets.push(stub);
    if (options?.autoConnect !== false) {
      open();
    }
    return socket;
  }
}

async function run(Impl: ProxyClass, script: Script): Promise<string[]> {
  installFakes();
  const scenario = new Scenario(Impl);
  try {
    await script(scenario);
    await scenario.settle();
    scenario.snapshot('end of script');
    scenario.tabs.forEach((tab, i) => scenario.call(`T${i}.closeChannel`, () => tab.closeChannel()));
    await scenario.settle();
    scenario.snapshot('all closed');
  }
  finally {
    restoreFakes();
  }
  return scenario.log;
}

// --- scenarios ---------------------------------------------------------------------

const SCENARIOS: Record<string, Script> = {
  'a lone primary: server traffic, flags, acks and teardown': async (s) => {
    const a = s.tab();
    await s.elect(0);
    s.snapshot('primary up');

    s.server(0, 'news', 'hello', { n: 1 });
    s.server(0, 'news', new Error('a custom parser produced this'));
    s.lifecycle(0, 'connect_error', new Error('handshake failed'));
    s.managerEvent(0, 'reconnect_attempt', 2);
    s.managerEvent(0, 'reconnect_error', new Error('refused'));
    s.managerEvent(0, 'reconnect_failed');

    s.call('emit', () => a.emit('chat', 'hi'));
    s.call('emit volatile timeout', () => a.volatile().timeout(250).emit('chat', 'x'));
    s.call('emit peers', () => a.peers().emit('chat', 'to peers'));
    s.call('emit reserved', () => a.volatile().emit('connect'));
    s.call('emit after a rejected one', () => a.emit('chat', 'clean'));
    s.call('ack ok', () => a.emitWithAck('ack-ok', 1));
    s.call('ack fail', () => a.timeout(100).emitWithAck('ack-fail'));
    s.call('ack reserved', () => a.emitWithAck('disconnect'));
    s.call('emit after ack', () => a.emit('chat', 'after ack'));
    await s.settle();

    a.on('boom', () => { throw new Error('listener blew up'); });
    s.server(0, 'boom', 1);
    s.server(0, 'news', () => 'cannot be cloned');

    s.call('connectionUpdate', () => a.connectionUpdate());
    s.call('disconnect', () => a.disconnect());
    s.snapshot('after disconnect');
    s.call('connect', () => a.connect());
    await s.advance(10);
    s.snapshot('after connect');

    s.call('sendMessageToPrimary', () => a.sendMessageToPrimary({ eventName: 'topic', message: { x: 1 } }));
    s.call('sendMessageToPrimary invalid', () => a.sendMessageToPrimary({ message: 1 }));
    s.call('directChannelEmit', () => a.directChannelEmit('direct', 1));
    s.call('closeChannel', () => a.closeChannel());
    s.snapshot('closed');

    for (const method of ['emit', 'connect', 'disconnect', 'connectionUpdate', 'directChannelEmit']) {
      s.call(`${method} after close`, () => a[method]('x'));
    }
    s.call('sendMessageToPrimary after close', () => a.sendMessageToPrimary({ eventName: 'topic' }));
    s.call('emitWithAck after close', () => a.emitWithAck('x'));
    s.call('forcePrimary after close', () => a.forcePrimary());
    s.call('initialize after close', () => a.initialize());
    s.call('closeChannel again', () => a.closeChannel());
    s.call('on after close', () => a.on('news', () => {}));
  },

  'a secondary relays everything through the primary': async (s) => {
    const a = s.tab();
    await s.elect(0);
    const b = s.tab();
    await s.init(1);
    s.snapshot('joined');

    s.call('T1 emit', () => b.emit('chat', 'from b'));
    s.call('T1 emit volatile', () => b.volatile().emit('chat', 'v'));
    s.call('T1 emit timeout', () => b.timeout(300).emit('chat', 't'));
    s.call('T1 emit peers', () => b.peers().emit('chat', 'p'));
    s.call('T1 emit every flag', () => b.volatile().timeout(0).peers().emit('chat', 'all'));
    s.call('T1 emit reserved', () => b.volatile().peers().emit('disconnecting'));
    s.call('T1 emit after a rejected one', () => b.emit('chat', 'clean'));
    s.call('T1 emit uncloneable', () => b.emit('chat', () => 1));
    s.call('T1 emit after uncloneable', () => b.emit('chat', 'fine'));
    s.call('T1 ack ok', () => b.emitWithAck('ack-ok', 'q'));
    s.call('T1 ack fail', () => b.volatile().timeout(50).emitWithAck('ack-fail'));
    s.call('T1 ack reserved', () => b.emitWithAck('connect'));
    s.call('T1 ack uncloneable', () => b.emitWithAck('ack-ok', () => 1));
    s.call('T1 ack slow', () => b.emitWithAck('ack-slow'));
    s.call('T1 peers is cleared by an ack', () => {
      b.peers();
      return b.emitWithAck('ack-ok');
    });
    s.call('T1 emit after that', () => b.emit('chat', 'not peers'));
    await s.settle();

    s.call('T1 sendMessageToPrimary', () => b.sendMessageToPrimary({ eventName: 'topic', message: 'm' }));
    s.call('T1 sendMessageToPrimary to nobody', () => b.sendMessageToPrimary({ eventName: 'unheard' }));
    s.call('T0 directChannelEmit', () => a.directChannelEmit('direct', 'to b'));
    s.call('T1 directChannelEmit', () => b.directChannelEmit('direct', 'to a'));
    s.server(0, 'news', 'for everyone');
    s.server(0, 'news', () => 'cannot be cloned');
    s.lifecycle(0, 'connect_error', new Error('flaky'));

    s.call('T1 connectionUpdate', () => b.connectionUpdate());
    s.call('T1 disconnect', () => b.disconnect());
    s.snapshot('T1 disconnected the channel');
    s.call('T1 connect', () => b.connect());
    await s.advance(10);
    s.snapshot('T1 reconnected the channel');

    s.tab();
    await s.init(2);
    await s.advance(10000);
    s.snapshot('the slow ack has timed out');

    s.call('T1 ack pending at close', () => b.emitWithAck('ack-slow'));
    s.call('T1 closeChannel', () => b.closeChannel());
    await s.advance(11000);
    s.snapshot('the pending ack failed at close, not on timeout');
  },

  'an announced departure, failover, and a page restored from cache': async (s) => {
    s.tab();
    await s.elect(0);
    s.tab();
    await s.init(1);
    s.tab();
    await s.init(2);

    s.page('pagehide');
    await s.advance(2000);
    await s.advance(10);
    s.snapshot('failed over');

    s.page('pageshow');
    await s.settle();
    s.snapshot('the restored tab is reconciled');

    await s.advance(20000);
    s.snapshot('steady');

    s.page('beforeunload');
    await s.advance(2500);
    s.snapshot('second departure');
  },

  'a silent death and heartbeat-driven failover': async (s) => {
    s.tab();
    await s.elect(0);
    s.tab();
    await s.init(1);
    const c = s.tab();
    await s.init(2);

    s.kill(0);
    await s.advance(13000);
    await s.advance(2500);
    s.snapshot('heartbeat lost, re-elected');

    s.call('T2 emit', () => c.emit('chat', 'after failover'));
    s.tabs[1].closeChannel();
    await s.advance(2500);
    s.snapshot('the new primary closed');
  },

  'a split brain reconciles to one primary': async (s) => {
    s.tab();
    s.tab();
    s.tab();
    s.pause();
    s.track('T0.initialize', s.tabs[0].initialize());
    s.track('T1.initialize', s.tabs[1].initialize());
    s.track('T2.initialize', s.tabs[2].initialize());
    await s.advance(2000);
    s.snapshot('everyone promoted');
    s.flush();
    await s.settle();
    s.snapshot('reconciled');
    await s.advance(6000);
    s.snapshot('steady');
  },

  'forcePrimary hands the socket over': async (s) => {
    const a = s.tab();
    await s.elect(0);
    const b = s.tab();
    await s.init(1);
    const c = s.tab();
    await s.init(2);

    s.call('T0 forcePrimary while primary', () => a.forcePrimary());
    s.call('T2 forcePrimary', () => c.forcePrimary());
    s.call('T2 forcePrimary again', () => c.forcePrimary());
    await s.settle();
    await s.advance(10);
    s.snapshot('T2 took over');

    s.call('T1 forcePrimary', () => b.forcePrimary());
    s.call('T0 forcePrimary', () => a.forcePrimary());
    await s.advance(2500);
    s.snapshot('two demands at once');
    await s.advance(6000);
    s.snapshot('steady');

    const d = s.tab('solo');
    s.call('T3 forcePrimary with nobody to answer', () => d.forcePrimary());
    s.call('T3 initialize after the demand', () => d.initialize());
    await s.advance(2000);
    s.snapshot('the lone demand promoted');
  },

  'a forced promotion is not abandoned for a rival claim': async (s) => {
    s.tab();
    await s.elect(0);
    s.tab();
    await s.init(1);
    const c = s.tab();
    await s.init(2);

    s.kill(0);
    await s.advance(12000);
    s.snapshot('both secondaries are electing');
    await s.advance(1000);
    s.call('T2 forcePrimary mid-election', () => c.forcePrimary());
    await s.advance(1000);
    s.snapshot('T1 has claimed; T2 is still demanding');
    await s.advance(500);
    s.snapshot('T2 has not given up');
    await s.advance(1500);
    s.snapshot('settled');
    await s.advance(6000);
    s.snapshot('steady');
  },

  'a demoted primary stops hearing page events': async (s) => {
    const a = s.tab();
    await s.elect(0);
    s.tab();
    await s.init(1);
    s.call('T1 forcePrimary', () => s.tabs[1].forcePrimary());
    await s.settle();
    await s.advance(10);
    s.page('pagehide');
    s.page('pageshow');
    s.page('beforeunload');
    await s.advance(3000);
    s.snapshot('only the new primary reacted');
    s.call('T0 forcePrimary back', () => a.forcePrimary());
    await s.settle();
    s.page('pagehide');
    await s.advance(2500);
    s.snapshot('handed back and departed');
  },

  'a deferred connection and intent across failover': async (s) => {
    const options = { autoConnect: false };
    const a = s.tab('deferred', options);
    await s.elect(0);
    const b = s.tab('deferred', options);
    await s.init(1);
    s.snapshot('nobody asked to connect');

    s.call('T1 connect', () => b.connect());
    await s.advance(10);
    s.snapshot('connected on request');
    s.call('T1 disconnect', () => b.disconnect());
    s.call('T0 connect', () => a.connect());
    await s.advance(10);
    s.call('T0 disconnect', () => a.disconnect());
    s.snapshot('deliberately offline');

    s.call('T0 closeChannel', () => a.closeChannel());
    await s.advance(2500);
    s.snapshot('promoted, still offline');

    const c = s.tab('deferred', options);
    await s.init(2);
    s.kill(1);
    s.call('T2 connect with the primary dead', () => c.connect());
    await s.advance(13000);
    await s.advance(2500);
    await s.advance(10);
    s.snapshot('the next primary honours the request');
  },

  'identity isolation and the diagnostics lobby': async (s) => {
    const name = (Impl: any, ...args: any[]) => s.call(`channelNameFor ${fmt(args)}`, () => Impl.channelNameFor(...args));
    name(s.Impl, 'mail', 'ws://server');
    name(s.Impl, 'mail', 'ws://server', { auth: { user: 'u1', token: 't' } });
    name(s.Impl, 'mail', 'ws://server', { auth: { token: 't', user: 'u1' }, transports: ['websocket'] });
    name(s.Impl, 'mail', 'ws://server', { auth: { user: 'u1' }, isolateByAuth: false });
    name(s.Impl, 'mail', 'ws://server', { auth: { big: 1n }, isolateByAuth: false });
    name(s.Impl, '', 'ws://server');
    name(s.Impl, 'mail', '');
    s.call('construct without a channel id', () => new s.Impl('', 'ws://server'));
    s.call('construct with a non-string url', () => new s.Impl('mail', 42 as any));

    s.tab('mail', { auth: { user: 'u1', token: 't' } });
    s.tab('mail', { auth: { user: 'u2', token: 't' } });
    s.tab('mail', { auth: { user: 'u1', token: 't', displayName: 'Ann' } });
    s.tab('mail', { auth: { user: 'u1', token: 't', displayName: 'Bob' } });
    s.tab('mail', { auth: { user: 'u1', token: 't' }, query: { v: 1 }, path: '/io' });
    s.tab('mail', { auth: { user: 'u3' }, isolateByAuth: false });
    s.tab('mail', { auth: { user: 'u4', token: 't' }, warnOnIdentityMismatch: false });
    for (let i = 0; i < s.tabs.length; i++) {
      await s.init(i);
    }
    await s.advance(2500);
    s.snapshot('each identity has its own primary');
  },

  'hostile and malformed traffic is ignored': async (s) => {
    const a = s.tab();
    await s.elect(0);
    s.tab();
    await s.init(1);
    const name = a.channelName;
    const token = deriveToken(name);
    const send = (data: unknown) => s.inject(name, data);

    send(null);
    send('a string');
    send({ type: 'EVENT', data: { event: 'news', args: [] } });
    send({ type: 'EVENT', token: 'v3.wrong', data: { event: 'news', args: [] } });
    send({ type: 'NOPE', token });
    send({ type: 'SOCKET_ID_RESPONSE', token, data: { id: 'x' } });
    send({ type: 'toString', token });
    send({ type: 'EVENT', token, data: { event: '', args: [] } });
    send({ type: 'EVENT', token, data: { event: 'news', args: 'x' } });
    send({ type: 'EVENT', token, data: { event: '__proto__', args: [1] } });
    send({ type: 'EVENT', token, data: { event: 'toString', args: [] } });
    send({ type: 'EMIT', token, data: { event: 'chat', args: [], timeout: -5, volatile: 'yes', notifyPeers: 'yes' } });
    send({ type: 'EMIT', token, data: { event: 'chat', args: [1], timeout: 20, volatile: true, notifyPeers: true } });
    send({ type: 'EMIT', token, data: { event: 'connect', args: [], notifyPeers: true } });
    send({ type: 'EMIT_WITH_ACK', token, data: { event: 'ack-ok', args: [], id: 'x1', timeout: Infinity } });
    send({ type: 'EMIT_WITH_ACK', token, data: { event: 'disconnect', args: [], id: 'x2' } });
    send({ type: 'EMIT_WITH_ACK', token, data: { event: 'ack-ok', args: [] } });
    send({ type: 'EMIT_WITH_ACK_RESPONSE', token, data: { id: 'unknown', response: 1 } });
    send({ type: 'CONNECTION_STATE', token, data: { connected: true, active: true, id: 42, wantsConnection: true } });
    send({ type: 'CONNECTION_STATE', token, data: { connected: true, active: false, id: '', wantsConnection: false } });
    send({ type: 'MESSAGE_TO_PRIMARY', token, data: { eventName: 'topic', message: [1] } });
    send({ type: 'MESSAGE_TO_PRIMARY', token, data: { message: [1] } });
    send({ type: 'HEARTBEAT', token, data: { tabId: 'zz'.repeat(24), epoch: NaN } });
    send({ type: 'PRIMARY_CLAIM', token, data: { tabId: '00'.repeat(24), epoch: Infinity } });
    send({ type: 'PRIMARY_CLAIM', token, data: { tabId: 'zz'.repeat(24) } });
    send({ type: 'PRIMARY_YIELD', token, data: { tabId: 'someone-else' } });
    send({ type: 'PRIMARY_DEMAND', token, data: { tabId: '' } });
    send({ type: 'PRIMARY_STOOD_DOWN', token, data: { tabId: 'x' } });
    send({ type: 'PRIMARY_LEAVING', token, data: { tabId: 'zz'.repeat(24) } });
    s.inject(`app::sioproxy-identity`, { kind: 'announce', tabId: 5 });
    s.inject(`app::sioproxy-identity`, { kind: 'reply', tabId: 'p', fingerprint: 'f', keys: [1] });
    s.inject(`app::sioproxy-identity`, { kind: 'shout', tabId: 'p', fingerprint: 'f', keys: [] });
    await s.settle();
    await s.advance(3000);
    s.snapshot('after the noise');

    send({ type: 'PRIMARY_ALIVE', token, data: { tabId: 'zz'.repeat(24), epoch: 9, connected: true, active: true, id: 'x', wantsConnection: true } });
    send({ type: 'PRIMARY_YIELD', token, data: { tabId: '' } });
    await s.advance(3000);
    s.snapshot('after a stronger primary appeared');
  },

  'listener and subscriber semantics': async (s) => {
    const a = s.tab();
    await s.elect(0);

    const once = () => s.record('once fired');
    a.once('news', once);
    const onceRemoved = () => s.record('removed once fired');
    a.once('news', onceRemoved);
    a.off('news', onceRemoved);
    const late = () => s.record('late listener fired');
    const self = () => {
      s.record('self-removing fired');
      a.off('news', self);
      a.on('news', late);
    };
    a.on('news', self);
    s.server(0, 'news', 1);
    s.server(0, 'news', 2);
    a.off('news');
    s.server(0, 'news', 3);
    a.off('never-registered', () => {});

    a.on('proxy_error', () => { throw new Error('error handler blew up'); });
    a.on('boom', () => { throw 'a thrown string'; });
    s.server(0, 'boom');

    let unsubscribeAdder: () => void = () => {};
    const added = () => s.record('check subscriber added mid-round');
    unsubscribeAdder = a.onPrimaryCheck(() => {
      s.record('check subscriber adds another');
      a.onPrimaryCheck(added);
      unsubscribeAdder();
    });
    let unsubscribeQuitter: () => void = () => {};
    unsubscribeQuitter = a.onPrimaryCheck(() => {
      s.record('check subscriber leaves');
      unsubscribeQuitter();
    });
    a.onPrimaryCheck(() => { throw new Error('check subscriber blew up'); });

    const leave = a.onProxyMessage('topic', () => {
      s.record('topic subscriber leaves');
      leave();
    });
    a.onProxyMessage('topic', () => { throw new Error('topic subscriber blew up'); });
    a.onProxyMessage('__proto__', (m: unknown) => s.record(`__proto__ subscriber ${fmt(m)}`));

    s.tab();
    await s.init(1);
    s.tab();
    await s.init(2);
    s.call('T1 message', () => s.tabs[1].sendMessageToPrimary({ eventName: 'topic', message: 1 }));
    s.call('T1 message', () => s.tabs[1].sendMessageToPrimary({ eventName: 'topic', message: 2 }));
    s.call('T1 __proto__ message', () => s.tabs[1].sendMessageToPrimary({ eventName: '__proto__', message: 3 }));
    leave();
    await s.settle();
  },
};

describe('behaviour scenarios', () => {
  test.each(Object.keys(SCENARIOS))('%s', async (name) => {
    expect(await run(SocketIOProxy as unknown as ProxyClass, SCENARIOS[name])).toMatchSnapshot();
  });
});
