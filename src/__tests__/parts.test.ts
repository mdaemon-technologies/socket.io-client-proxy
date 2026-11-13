import { vi, describe, test, expect, beforeEach, type Mock } from 'vitest';
import { digest, stableStringify } from '../util/hash';
import { invokeAll, Waiters } from '../util/callbacks';
import type { TimerHandle, Timers } from '../util/timers';
import { connectionIdentity, identityKeys, resolveIdentity } from '../identity/identity';
import { IdentityLobby } from '../identity/lobby';
import { assertChannelArgs, DEFAULTS, resolveOptions } from '../options';
import { NO_ID, PROXY_ERROR_EVENT } from '../protocol/constants';
import {
  deriveToken,
  isMessageType,
  MESSAGE_TYPES,
  validateMessage,
  type MessageHandlers,
} from '../protocol/messages';
import { ChannelTransport, type ChannelLike } from '../protocol/transport';
import { LocalEmitter } from '../events/local-emitter';
import { KeyedSubscribers, SubscriberSet } from '../events/subscribers';
import { ConnectionStateStore, describeSocket } from '../connection/state';
import { PrimarySocket } from '../connection/primary-socket';
import { AckTracker, forwardAck } from '../emit/acks';
import { applyFlags, EmitFlags, encodeFlags } from '../emit/flags';
import { HeartbeatMonitor, HeartbeatSender } from '../primacy/heartbeat';
import { PageLifecycle } from '../primacy/page-lifecycle';
import { Primacy } from '../primacy/primacy';

/**
 * Unit specs for the parts the proxy is built from. Each part takes its
 * collaborators as arguments, so these use plain fakes — a hand-driven clock,
 * an in-memory channel, a stub socket — rather than module mocks and globals.
 * The end-to-end behaviour stays covered by the other spec files.
 */

/** A clock that only moves when told to. */
class ManualTimers implements Timers {
  private time = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; every: number | null; run: () => void }>();

  now = () => this.time;
  setTimeout = (run: () => void, ms: number) => this.add(run, ms, null);
  setInterval = (run: () => void, ms: number) => this.add(run, ms, ms);
  clearTimeout = (handle: TimerHandle) => { this.tasks.delete(handle as unknown as number); };
  clearInterval = (handle: TimerHandle) => { this.tasks.delete(handle as unknown as number); };

  get pending(): number {
    return this.tasks.size;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let due: [number, { at: number; every: number | null; run: () => void }] | undefined;
      this.tasks.forEach((task, id) => {
        if (task.at <= end && (!due || task.at < due[1].at)) {
          due = [id, task];
        }
      });
      if (!due) {
        break;
      }
      const [id, task] = due;
      this.time = task.at;
      if (task.every === null) {
        this.tasks.delete(id);
      }
      else {
        task.at += task.every;
      }
      task.run();
    }
    this.time = end;
  }

  private add(run: () => void, ms: number, every: number | null): TimerHandle {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + ms, every, run });
    return id as unknown as TimerHandle;
  }
}

type FakeChannel = ChannelLike & { postMessage: Mock<(message: any) => void>; close: Mock<() => void> };

function fakeChannel(): FakeChannel {
  return { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
}

const silent = () => {};

describe('util', () => {
  test('digest is 16 hex characters and deterministic', () => {
    expect(digest('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(digest('abc')).toBe(digest('abc'));
    expect(digest('abc')).not.toBe(digest('abd'));
  });

  test('stableStringify ignores key order and survives cycles', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }))
      .toBe(stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(stableStringify(cyclic)).toContain('[cyclic]');
    expect(stableStringify(undefined)).toBe('undefined');
  });

  test('invokeAll isolates a throwing callback and works on a copy', () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const list: (() => void)[] = [];
    list.push(() => { calls.push('a'); list.push(() => calls.push('late')); });
    list.push(() => { throw new Error('boom'); });
    list.push(() => calls.push('c'));

    invokeAll(list, [], (err) => errors.push(err));

    expect(calls).toEqual(['a', 'c']);
    expect(errors).toHaveLength(1);
  });

  test('Waiters releases everyone so far, once', () => {
    const waiters = new Waiters();
    const a = vi.fn();
    waiters.add(a);
    waiters.resolveAll();
    waiters.resolveAll();
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe('options', () => {
  test('applies the defaults and keeps socket.io options, autoConnect included', () => {
    const config = resolveOptions('ws://host', { autoConnect: false, transports: ['websocket'], debug: true });
    expect(config).toMatchObject({
      ...DEFAULTS,
      debug: true,
      autoConnect: false,
      socketOptions: { autoConnect: false, transports: ['websocket'] },
    });
    expect(config.socketOptions).not.toHaveProperty('debug');
  });

  test('assertChannelArgs rejects empty or non-string input', () => {
    expect(() => assertChannelArgs('', 'ws://x')).toThrow('channelId is required');
    expect(() => assertChannelArgs('c', 42)).toThrow('url is required');
    expect(() => assertChannelArgs('c', 'ws://x')).not.toThrow();
  });
});

describe('identity', () => {
  test('key paths name the fields, never the values', () => {
    const identity = connectionIdentity('ws://h', { auth: { user: 'u', token: 't' }, path: '/io' });
    expect(identityKeys(identity)).toEqual(['auth.token', 'auth.user', 'path', 'url']);
  });

  test('isolation folds the fingerprint into the name', () => {
    const isolated = resolveIdentity('app', 'ws://h', { auth: { t: 1 } }, true);
    expect(isolated.name).toBe(`app#${isolated.fingerprint}`);
    expect(resolveIdentity('app', 'ws://h', { auth: { t: 1 } }, false).name).toBe('app');
    expect(resolveIdentity('app', 'ws://h', { auth: { t: 2 } }, true).name).not.toBe(isolated.name);
  });

  test('the lobby announces, replies to announcements only, and warns once per key mismatch', () => {
    const channel = fakeChannel();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lobby = new IdentityLobby('app', { tabId: 'me', fingerprint: 'f1', keys: ['url'] }, () => channel, silent);

    lobby.open();
    expect(channel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'announce', tabId: 'me' }));

    const peer = { tabId: 'peer', fingerprint: 'f2', keys: ['auth.token', 'url'] };
    channel.onmessage!({ data: { kind: 'announce', ...peer } } as MessageEvent);
    channel.onmessage!({ data: { kind: 'reply', ...peer } } as MessageEvent);

    expect(channel.postMessage.mock.calls.filter((c) => c[0].kind === 'reply')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    lobby.close();
    expect(channel.close).toHaveBeenCalled();
    expect(channel.onmessage).toBeNull();
    warn.mockRestore();
  });
});

describe('protocol', () => {
  const token = deriveToken('chan');

  test('the payload map lists sixteen message types', () => {
    expect(MESSAGE_TYPES).toHaveLength(16);
    expect(isMessageType('HEARTBEAT')).toBe(true);
    expect(isMessageType('toString')).toBe(false);
    expect(isMessageType('__proto__')).toBe(false);
  });

  test('the token depends on the protocol version and the channel name', () => {
    expect(token).toMatch(/^v3\.[0-9a-f]{16}$/);
    expect(deriveToken('other')).not.toBe(token);
  });

  test('validateMessage checks type, then tag, then payload', () => {
    expect(validateMessage(null, token).valid).toBe(false);
    expect(validateMessage({ type: 'NOPE', token }, token).valid).toBe(false);
    expect(validateMessage({ type: 'CONNECT', token: 'x' }, token).valid).toBe(false);
    expect(validateMessage({ type: 'HEARTBEAT', data: { tabId: 't' }, token }, token)).toMatchObject({
      valid: false, type: 'HEARTBEAT',
    });
    expect(validateMessage({ type: 'CONNECT', token }, token)).toEqual({
      valid: true, type: 'CONNECT', data: undefined,
    });
    expect(validateMessage({ type: 'HEARTBEAT', data: { tabId: 't', epoch: 2 }, token }, token).valid)
      .toBe(true);
  });

  describe('transport', () => {
    let channel: FakeChannel;
    let reportError: Mock<(context: string, error: unknown) => void>;
    let transport: ChannelTransport;

    beforeEach(() => {
      channel = fakeChannel();
      reportError = vi.fn();
      transport = new ChannelTransport('chan', () => channel, silent, reportError);
    });

    test('post tags the message and lets a failure through', () => {
      transport.post({ type: 'CONNECT' });
      expect(channel.postMessage).toHaveBeenCalledWith({ type: 'CONNECT', token });

      channel.postMessage.mockImplementation(() => { throw new Error('clone'); });
      expect(() => transport.post({ type: 'CONNECT' })).toThrow('clone');
    });

    test('safePost reports a failure instead', () => {
      channel.postMessage.mockImplementation(() => { throw new Error('clone'); });
      expect(() => transport.safePost({ type: 'CONNECT' })).not.toThrow();
      expect(reportError).toHaveBeenCalledWith('sending CONNECT', expect.any(Error));
    });

    test('routes valid messages, drops invalid ones, and contains handler errors', () => {
      const handlers = { CONNECT: vi.fn(() => { throw new Error('handler'); }), DISCONNECT: vi.fn() };
      transport.listen(handlers as unknown as MessageHandlers);

      channel.onmessage!({ data: { type: 'DISCONNECT', token: 'wrong' } } as MessageEvent);
      expect(handlers.DISCONNECT).not.toHaveBeenCalled();

      channel.onmessage!({ data: { type: 'CONNECT', token } } as MessageEvent);
      expect(reportError).toHaveBeenCalledWith('handling a CONNECT message', expect.any(Error));
    });

    test('after close it drops posts and stops listening', () => {
      transport.listen({} as MessageHandlers);
      transport.close();
      transport.close();

      transport.post({ type: 'CONNECT' });
      expect(channel.postMessage).not.toHaveBeenCalled();
      expect(channel.onmessage).toBeNull();
      expect(channel.close).toHaveBeenCalledTimes(1);
      expect(transport.closed).toBe(true);
    });
  });
});

describe('events', () => {
  test('LocalEmitter: once, off and clear', () => {
    const emitter = new LocalEmitter(silent);
    const once = vi.fn();
    emitter.once('e', once);
    emitter.emit('e', 1);
    emitter.emit('e', 2);
    expect(once).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount('e')).toBe(0);

    const kept = vi.fn();
    emitter.on('e', kept);
    emitter.on('f', vi.fn());
    expect(emitter.size).toBe(2);
    emitter.off('f');
    expect(emitter.size).toBe(1);

    emitter.clear();
    expect(emitter.size).toBe(0);
  });

  test('LocalEmitter reports a throwing listener, and swallows a throwing error handler', () => {
    const emitter = new LocalEmitter(silent);
    const onError = vi.fn(() => { throw new Error('handler'); });
    emitter.on(PROXY_ERROR_EVENT, onError);
    emitter.on('e', () => { throw 'not an Error'; });

    expect(() => emitter.emit('e')).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'dispatching "e" to a listener');
  });

  test('SubscriberSet and KeyedSubscribers unsubscribe and clear', () => {
    const set = new SubscriberSet<[]>();
    const unsubscribe = set.add(vi.fn());
    set.add(vi.fn());
    unsubscribe();
    expect(set.size).toBe(1);
    set.clear();
    expect(set.size).toBe(0);

    const keyed = new KeyedSubscribers<number>();
    const subscriber = vi.fn();
    const off = keyed.subscribe('a', subscriber);
    keyed.subscribe('b', vi.fn());
    keyed.publish('a', 1, silent);
    expect(subscriber).toHaveBeenCalledWith(1);
    off();
    off();
    expect(keyed.size).toBe(1);
    keyed.clear();
    expect(keyed.size).toBe(0);
  });
});

describe('connection state', () => {
  test('encodes a missing id as the sentinel and decodes it back', () => {
    expect(describeSocket(null, true)).toEqual({ connected: false, active: false, id: NO_ID, wantsConnection: true });

    const store = new ConnectionStateStore(false);
    store.apply({ connected: true, active: true, id: NO_ID, wantsConnection: true });
    expect(store.snapshot()).toEqual({ connected: true, id: undefined, active: true, wantsConnection: true });
  });

  test('capture copies the socket and keeps the intent; reset keeps the intent too', () => {
    const store = new ConnectionStateStore(false);
    expect(store.capture({ connected: true, active: true, id: 'sid' })).toEqual({
      connected: true, active: true, id: 'sid', wantsConnection: false,
    });
    expect(store.id).toBe('sid');

    store.reset();
    expect(store.snapshot()).toEqual({ connected: false, id: undefined, active: false, wantsConnection: false });
  });
});

describe('emit flags and acks', () => {
  test('take() hands the flags over once', () => {
    const flags = new EmitFlags();
    flags.volatile();
    flags.timeout(50);
    flags.peers();
    expect(flags.take()).toEqual({ volatile: true, timeout: 50, notifyPeers: true });
    expect(flags.take()).toEqual({ volatile: false, timeout: null, notifyPeers: false });
  });

  test('encodeFlags includes only what is set', () => {
    expect(encodeFlags({ volatile: false, timeout: null, notifyPeers: true })).toEqual({});
    expect(encodeFlags({ volatile: true, timeout: 0, notifyPeers: false })).toEqual({ volatile: true, timeout: 0 });
  });

  test('applyFlags ignores an untrusted timeout that is out of range', () => {
    const timed = { emit: vi.fn() };
    const socket: any = { timeout: vi.fn(() => timed), volatile: 'volatile-operator' };
    expect(applyFlags(socket, { timeout: -1, volatile: 'yes' })).toBe(socket);
    expect(applyFlags(socket, { timeout: Infinity })).toBe(socket);
    expect(applyFlags(socket, { timeout: 5 })).toBe(timed);
  });

  test('AckTracker settles, times out and fails what is left', async () => {
    const timers = new ManualTimers();
    let next = 0;
    const acks = new AckTracker(1000, timers, () => `id${++next}`);

    const ok = acks.track(vi.fn());
    acks.settle({ id: 'id1', response: 'yes' });
    await expect(ok).resolves.toBe('yes');

    const failed = acks.track(vi.fn());
    acks.settle({ id: 'id2', error: 'nope' });
    await expect(failed).rejects.toThrow('nope');

    const late = acks.track(vi.fn());
    timers.advance(1000);
    await expect(late).rejects.toThrow('timed out');

    const orphan = acks.track(vi.fn());
    acks.rejectAll(new Error('closed'));
    await expect(orphan).rejects.toThrow('closed');
    expect(acks.size).toBe(0);
    expect(timers.pending).toBe(0);
  });

  test('AckTracker cleans up when sending throws', async () => {
    const timers = new ManualTimers();
    const acks = new AckTracker(1000, timers, () => 'id');
    await expect(acks.track(() => { throw new Error('clone'); })).rejects.toThrow('clone');
    expect(acks.size).toBe(0);
    expect(timers.pending).toBe(0);
  });

  test('forwardAck answers with the response or the error message', async () => {
    const respond = vi.fn();
    forwardAck(() => Promise.resolve(7), 'a', respond);
    forwardAck(() => Promise.reject(new Error('server said no')), 'b', respond);
    await Promise.resolve();
    await Promise.resolve();
    expect(respond).toHaveBeenCalledWith({ id: 'a', response: 7 });
    expect(respond).toHaveBeenCalledWith({ id: 'b', response: undefined, error: 'server said no' });
  });
});

describe('primary socket', () => {
  function stubSocket() {
    const manager = { on: vi.fn(), off: vi.fn() };
    return {
      onAny: vi.fn(), on: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
      active: false, connected: false, id: undefined, io: manager,
    } as any;
  }

  test('relays only while current, and dispose undoes the Manager wiring', () => {
    const socket = stubSocket();
    let current = true;
    const hooks = { isCurrent: () => current, relay: vi.fn(), stateChanged: vi.fn() };
    const primary = new PrimarySocket('ws://h', {}, () => socket, hooks);

    socket.onAny.mock.calls[0][0]('news', 1);
    const connect = socket.on.mock.calls.find((c: any[]) => c[0] === 'connect')[1];
    connect();
    expect(hooks.relay).toHaveBeenCalledWith('news', [1], 'server');
    expect(hooks.stateChanged).toHaveBeenCalledTimes(1);

    current = false;
    socket.onAny.mock.calls[0][0]('late', 2);
    expect(hooks.relay).not.toHaveBeenCalledWith('late', [2]);

    primary.dispose();
    expect(socket.io.off).toHaveBeenCalledTimes(socket.io.on.mock.calls.length);
    expect(socket.disconnect).toHaveBeenCalled();
  });

  test('applyIntent opens a closed socket or closes an unwanted one', () => {
    const socket = stubSocket();
    const hooks = { isCurrent: () => true, relay: vi.fn(), stateChanged: vi.fn() };
    const primary = new PrimarySocket('ws://h', {}, () => socket, hooks);

    primary.applyIntent(true);
    expect(socket.connect).toHaveBeenCalled();

    socket.active = true;
    primary.applyIntent(false);
    expect(socket.disconnect).toHaveBeenCalled();
  });
});

describe('primacy', () => {
  test('the heartbeat monitor fires only after silence longer than the timeout', () => {
    const timers = new ManualTimers();
    const lost = vi.fn();
    const monitor = new HeartbeatMonitor(timers, 1000, 2500, lost);
    monitor.start();

    timers.advance(2000);
    monitor.touch();
    timers.advance(2000);
    expect(lost).not.toHaveBeenCalled();

    timers.advance(1000);
    expect(lost).toHaveBeenCalled();
    monitor.stop();
    expect(monitor.running).toBe(false);
  });

  test('the heartbeat sender beats on its interval until stopped', () => {
    const timers = new ManualTimers();
    const beat = vi.fn();
    const sender = new HeartbeatSender(timers, 100, beat);
    sender.start();
    timers.advance(350);
    sender.stop();
    timers.advance(1000);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  test('page lifecycle attaches and detaches the same three listeners', () => {
    const page = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const lifecycle = new PageLifecycle(() => page, vi.fn(), vi.fn());
    lifecycle.attach();
    lifecycle.detach();
    expect(page.addEventListener.mock.calls.map((c) => c[0])).toEqual(['beforeunload', 'pagehide', 'pageshow']);
    expect(page.removeEventListener.mock.calls).toEqual(page.addEventListener.mock.calls);
    expect(() => new PageLifecycle(() => undefined, vi.fn(), vi.fn()).attach()).not.toThrow();
  });

  describe('coordinator', () => {
    let timers: ManualTimers;
    let posted: any[];
    let host: {
      openSocket: Mock<() => void>;
      detachSocket: Mock<() => void>;
      releaseSocket: Mock<() => void>;
      hasSocket: () => boolean;
    };
    let primacy: Primacy;

    beforeEach(() => {
      timers = new ManualTimers();
      posted = [];
      host = { openSocket: vi.fn(), detachSocket: vi.fn(), releaseSocket: vi.fn(), hasSocket: () => true };
      primacy = new Primacy(
        { tabId: 'mm', electionTimeout: 100, electionJitter: 0, heartbeatInterval: 50, heartbeatTimeout: 200 },
        host,
        (message) => posted.push(message),
        { timers, random: () => 0, page: () => undefined },
        silent,
      );
    });

    const types = () => posted.map((m) => m.type);
    const lastPosted = () => posted[posted.length - 1];

    test('promotes itself when nobody answers, and claims epoch 1', async () => {
      const done = primacy.initialize();
      expect(types()).toEqual(['PRIMARY_CHECK']);
      timers.advance(100);
      await done;

      expect(primacy.isPrimary).toBe(true);
      expect(host.openSocket).toHaveBeenCalledTimes(1);
      expect(lastPosted()).toEqual({ type: 'PRIMARY_CLAIM', data: { tabId: 'mm', epoch: 1 } });
    });

    test('settles as a secondary when a primary answers, adopting its state', async () => {
      const adopt = vi.fn();
      const done = primacy.initialize();
      primacy.onPrimaryAlive(
        { tabId: 'zz', epoch: 4, connected: true, active: true, id: 's', wantsConnection: true },
        adopt,
      );
      await done;

      expect(primacy.isPrimary).toBe(false);
      expect(adopt).toHaveBeenCalled();
      expect(host.openSocket).not.toHaveBeenCalled();
    });

    test('a forced promotion outranks every epoch seen', async () => {
      primacy.onHeartbeat({ tabId: 'zz', epoch: 7 });
      const forced = primacy.forcePrimary();
      expect(types()).toContain('PRIMARY_DEMAND');
      primacy.onStoodDown({ tabId: 'mm' });
      await forced;

      expect(primacy.claim()).toEqual({ tabId: 'mm', epoch: 8 });
    });

    test('of two primaries, the lower epoch yields; within an epoch, the lower tabId', async () => {
      const done = primacy.initialize();
      timers.advance(100);
      await done;

      primacy.onClaim({ tabId: 'aa', epoch: 1 });
      expect(lastPosted()).toEqual({ type: 'PRIMARY_YIELD', data: { tabId: 'aa' } });
      expect(primacy.isPrimary).toBe(true);

      primacy.onClaim({ tabId: 'aa', epoch: 2 });
      expect(primacy.isPrimary).toBe(false);
      expect(host.releaseSocket).toHaveBeenCalledTimes(1);
    });

    test('departure is announced once, and close stops every timer', async () => {
      const done = primacy.initialize();
      timers.advance(100);
      await done;

      primacy.announceDeparture();
      primacy.announceDeparture();
      expect(types().filter((t) => t === 'PRIMARY_LEAVING')).toHaveLength(1);
      expect(primacy.serving).toBe(false);

      primacy.close();
      expect(timers.pending).toBe(0);
      expect(primacy.isPrimary).toBe(false);
      expect(host.releaseSocket).toHaveBeenCalled();
    });
  });
});
