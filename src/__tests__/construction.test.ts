import SocketIOProxy from '../socket-io-proxy';
import { io } from 'socket.io-client';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  Harness,
  installFakes,
  restoreFakes,
  getToken,
  electAsPrimary,
  joinAsSecondary,
  respondAsPrimary,
  connectionState,
} from './helpers/harness';

jest.mock('socket.io-client');

describe('construction and initialization', () => {
  let h: Harness;
  let socketProxy: SocketIOProxy;

  beforeEach(() => {
    h = installFakes();
    socketProxy = new SocketIOProxy('test-channel', 'ws://test-url');
  });

  afterEach(restoreFakes);

  describe('argument validation', () => {
    test('throws when channelId is empty', () => {
      expect(() => new SocketIOProxy('', 'ws://test-url')).toThrow(
        'channelId is required and must be a non-empty string'
      );
    });

    test('throws when channelId is not a string', () => {
      expect(() => new SocketIOProxy(undefined as any, 'ws://test-url')).toThrow(
        'channelId is required and must be a non-empty string'
      );
    });

    test('throws when url is empty', () => {
      expect(() => new SocketIOProxy('ch', '')).toThrow(
        'url is required and must be a non-empty string'
      );
    });

    test('throws when url is not a string', () => {
      expect(() => new SocketIOProxy('ch', undefined as any)).toThrow(
        'url is required and must be a non-empty string'
      );
    });
  });

  describe('connection-identity channel isolation', () => {
    test('tabs with matching auth share a channel', () => {
      const a = new SocketIOProxy('app', 'ws://host', { auth: { token: 'same' } });
      const b = new SocketIOProxy('app', 'ws://host', { auth: { token: 'same' } });
      expect(a.channelName).toBe(b.channelName);
    });

    test('tabs with different auth get separate channels', () => {
      const a = new SocketIOProxy('app', 'ws://host', { auth: { token: 'user-a' } });
      const b = new SocketIOProxy('app', 'ws://host', { auth: { token: 'user-b' } });
      expect(a.channelName).not.toBe(b.channelName);
    });

    test('key order in auth does not change the channel', () => {
      const a = new SocketIOProxy('app', 'ws://host', { auth: { x: 1, y: 2 } as any });
      const b = new SocketIOProxy('app', 'ws://host', { auth: { y: 2, x: 1 } as any });
      expect(a.channelName).toBe(b.channelName);
    });

    test('different urls get separate channels', () => {
      const a = new SocketIOProxy('app', 'ws://host-a');
      const b = new SocketIOProxy('app', 'ws://host-b');
      expect(a.channelName).not.toBe(b.channelName);
    });

    test('different query or path gets separate channels', () => {
      const base = new SocketIOProxy('app', 'ws://host');
      const scoped = new SocketIOProxy('app', 'ws://host', { path: '/other' });
      const queried = new SocketIOProxy('app', 'ws://host', { query: { room: '1' } });
      expect(scoped.channelName).not.toBe(base.channelName);
      expect(queried.channelName).not.toBe(base.channelName);
    });

    test('non-identity options do not change the channel', () => {
      const a = new SocketIOProxy('app', 'ws://host', { transports: ['websocket'] });
      const b = new SocketIOProxy('app', 'ws://host', { transports: ['polling'] });
      expect(a.channelName).toBe(b.channelName);
    });

    test('isolateByAuth: false uses the raw channelId', () => {
      const proxy = new SocketIOProxy('app', 'ws://host', { auth: { token: 'x' }, isolateByAuth: false });
      expect(proxy.channelName).toBe('app');
    });

    test('cyclic options do not throw', () => {
      const auth: any = { token: 'x' };
      auth.self = auth;
      expect(() => new SocketIOProxy('app', 'ws://host', { auth })).not.toThrow();
    });

    test('an auth callback is fingerprinted by its source', () => {
      const a = new SocketIOProxy('app', 'ws://host', { auth: (cb: any) => cb({ t: 1 }) });
      const b = new SocketIOProxy('app', 'ws://host', { auth: (cb: any) => cb({ t: 1 }) });
      const c = new SocketIOProxy('app', 'ws://host', { auth: (cb: any) => cb({ t: 2 }) });
      expect(a.channelName).toBe(b.channelName);
      expect(a.channelName).not.toBe(c.channelName);
    });

    test('channelName exposes the effective channel', () => {
      expect(socketProxy.channelName).toContain('test-channel#');
    });
  });

  describe('channelNameFor', () => {
    test('agrees with an actual instance', () => {
      const options = { auth: { token: 'abc' }, transports: ['websocket'] as any };
      const proxy = new SocketIOProxy('app', 'ws://host', options);
      expect(SocketIOProxy.channelNameFor('app', 'ws://host', options)).toBe(proxy.channelName);
    });

    test('lets two call sites be compared without constructing anything', () => {
      // The assertion that turns a silent runtime split into a failing test.
      const shared = SocketIOProxy.channelNameFor('rtc', 'ws://host', { auth: { user: 'u', token: 't' } });
      const same = SocketIOProxy.channelNameFor('rtc', 'ws://host', { auth: { token: 't', user: 'u' } });
      const drifted = SocketIOProxy.channelNameFor('rtc', 'ws://host', { auth: { user: 'u' } });

      expect(same).toBe(shared);
      expect(drifted).not.toBe(shared);
    });

    test('opens no channel', () => {
      (globalThis.BroadcastChannel as jest.Mock).mockClear();
      SocketIOProxy.channelNameFor('app', 'ws://host');
      expect(globalThis.BroadcastChannel).not.toHaveBeenCalled();
    });

    test('honours isolateByAuth: false', () => {
      expect(SocketIOProxy.channelNameFor('app', 'ws://host', { isolateByAuth: false })).toBe('app');
    });

    test('validates its arguments like the constructor', () => {
      expect(() => SocketIOProxy.channelNameFor('', 'ws://host')).toThrow('channelId is required');
      expect(() => SocketIOProxy.channelNameFor('app', '')).toThrow('url is required');
    });
  });

  describe('identity mismatch diagnostics', () => {
    const LOBBY = '::sioproxy-identity';

    /** An announcement from a peer tab, as it would arrive on the lobby. */
    function announce(keys: string[], fingerprint = 'different-fingerprint', kind = 'announce') {
      return { data: { kind, tabId: 'peer-tab', fingerprint, keys } };
    }

    test('announces itself on a lobby keyed by the RAW channel id', () => {
      const proxy = new SocketIOProxy('rtc', 'ws://host', { auth: { user: 'u', token: 't' } });

      expect(globalThis.BroadcastChannel).toHaveBeenCalledWith('rtc' + LOBBY);
      expect(h.lobbyChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'announce',
          fingerprint: expect.any(String),
          keys: ['auth.token', 'auth.user', 'url'],
        })
      );
      // Values must never leave the tab; only key paths do.
      const posted = h.lobbyChannel.postMessage.mock.calls[0][0] as any;
      expect(JSON.stringify(posted)).not.toContain('"t"');
      void proxy;
    });

    test('warns when a peer describes its identity with different keys', () => {
      // The classic drift: one call site passes displayName, the other omits it.
      new SocketIOProxy('rtc', 'ws://host', { auth: { user: 'u', token: 't' } });
      h.lobbyChannel.onmessage(announce(['auth.displayName', 'auth.token', 'auth.user', 'url']));

      expect(h.warn).toHaveBeenCalledTimes(1);
      const text = h.warn.mock.calls[0].join(' ');
      expect(text).toContain('"rtc"');
      expect(text).toContain('auth.displayName');
      expect(text).toContain('channelNameFor');
    });

    test('stays silent when only the values differ — that is two users', () => {
      // Same key shape, different fingerprint: exactly what the isolation is
      // for, so warning here would make the library cry wolf.
      new SocketIOProxy('rtc', 'ws://host', { auth: { user: 'a', token: 't' } });
      h.lobbyChannel.onmessage(announce(['auth.token', 'auth.user', 'url']));

      expect(h.warn).not.toHaveBeenCalled();
    });

    test('stays silent for a peer with the same identity', () => {
      const proxy = new SocketIOProxy('rtc', 'ws://host', { auth: { user: 'u', token: 't' } });
      const fingerprint = (proxy as any).identityFingerprint;
      h.lobbyChannel.onmessage(announce(['auth.token', 'auth.user', 'url'], fingerprint));

      expect(h.warn).not.toHaveBeenCalled();
    });

    test('warns once per distinct mismatch, however many peers repeat it', () => {
      new SocketIOProxy('rtc', 'ws://host', { auth: { user: 'u', token: 't' } });
      const peer = ['auth.displayName', 'auth.token', 'auth.user', 'url'];

      h.lobbyChannel.onmessage(announce(peer));
      h.lobbyChannel.onmessage(announce(peer));
      h.lobbyChannel.onmessage(announce(peer, 'yet-another-fingerprint'));

      expect(h.warn).toHaveBeenCalledTimes(1);
    });

    test('answers an announcement so the newcomer learns about this tab', () => {
      new SocketIOProxy('rtc', 'ws://host');
      h.lobbyChannel.postMessage.mockClear();

      h.lobbyChannel.onmessage(announce(['url']));
      expect(h.lobbyChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'reply' })
      );
    });

    test('never answers a reply, so the exchange cannot ping-pong', () => {
      new SocketIOProxy('rtc', 'ws://host');
      h.lobbyChannel.postMessage.mockClear();

      h.lobbyChannel.onmessage(announce(['url'], 'different-fingerprint', 'reply'));
      expect(h.lobbyChannel.postMessage).not.toHaveBeenCalled();
    });

    test('ignores its own announcement echoed back', () => {
      const proxy = new SocketIOProxy('rtc', 'ws://host');
      h.lobbyChannel.postMessage.mockClear();

      h.lobbyChannel.onmessage({
        data: { kind: 'announce', tabId: (proxy as any).tabId, fingerprint: 'x', keys: [] },
      });
      expect(h.warn).not.toHaveBeenCalled();
      expect(h.lobbyChannel.postMessage).not.toHaveBeenCalled();
    });

    test.each([
      ['not an object', 'nonsense'],
      ['an unknown kind', { kind: 'gossip', tabId: 'p', fingerprint: 'f', keys: [] }],
      ['a missing tabId', { kind: 'announce', fingerprint: 'f', keys: [] }],
      ['non-string keys', { kind: 'announce', tabId: 'p', fingerprint: 'f', keys: [1, 2] }],
      ['keys that are not an array', { kind: 'announce', tabId: 'p', fingerprint: 'f', keys: 'url' }],
    ])('ignores a malformed announcement: %s', (_label, payload) => {
      new SocketIOProxy('rtc', 'ws://host');
      expect(() => h.lobbyChannel.onmessage({ data: payload })).not.toThrow();
      expect(h.warn).not.toHaveBeenCalled();
    });

    test('warnOnIdentityMismatch: false opens no lobby at all', () => {
      (globalThis.BroadcastChannel as jest.Mock).mockClear();
      new SocketIOProxy('rtc', 'ws://host', { warnOnIdentityMismatch: false });

      const names = (globalThis.BroadcastChannel as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(names.some((n: string) => n.endsWith(LOBBY))).toBe(false);
    });

    test('isolateByAuth: false opens no lobby either', () => {
      // Nothing to detect: every tab uses the channel id verbatim.
      (globalThis.BroadcastChannel as jest.Mock).mockClear();
      new SocketIOProxy('rtc', 'ws://host', { isolateByAuth: false });

      const names = (globalThis.BroadcastChannel as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(names.some((n: string) => n.endsWith(LOBBY))).toBe(false);
    });

    test('closeChannel closes the lobby too', () => {
      const proxy = new SocketIOProxy('rtc', 'ws://host');
      proxy.closeChannel();
      expect(h.lobbyChannel.close).toHaveBeenCalled();
      expect(h.lobbyChannel.onmessage).toBeNull();
    });

    test('a lobby that cannot be posted to does not break the proxy', () => {
      h.lobbyChannel.postMessage.mockImplementation(() => { throw new Error('InvalidStateError'); });
      expect(() => new SocketIOProxy('rtc', 'ws://host')).not.toThrow();
    });
  });

  describe('channel tag', () => {
    test('is derived from the channel, so peers agree from construction', () => {
      const a = new SocketIOProxy('shared-channel', 'ws://test-url');
      const b = new SocketIOProxy('shared-channel', 'ws://test-url');
      expect(getToken(a)).toBe(getToken(b));
    });

    test('differs between channels', () => {
      const a = new SocketIOProxy('channel-a', 'ws://test-url');
      const b = new SocketIOProxy('channel-b', 'ws://test-url');
      expect(getToken(a)).not.toBe(getToken(b));
    });

    test('is included in outgoing messages', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      h.mockChannel.postMessage.mockClear();
      socketProxy.emit('test', 'data');

      const call = h.mockChannel.postMessage.mock.calls[0][0] as any;
      expect(call.token).toBe(getToken(socketProxy));
    });

    test('messages with a missing tag are rejected', async () => {
      await electAsPrimary(socketProxy);

      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      h.mockChannel.onmessage({ data: { type: 'EVENT', data: { event: 'test-event', args: ['x'] } } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('messages with a wrong tag are rejected', async () => {
      await electAsPrimary(socketProxy);

      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      h.mockChannel.onmessage({
        data: { type: 'EVENT', data: { event: 'test-event', args: ['x'] }, token: 'wrong-token' },
      });
      expect(callback).not.toHaveBeenCalled();
    });

    test('a PRIMARY_CHECK carrying a wrong tag is rejected', async () => {
      await electAsPrimary(socketProxy);

      h.mockChannel.postMessage.mockClear();
      // Handshake messages are no longer exempt from the tag check, so a
      // foreign tab cannot probe for the primary or inject a forged tag.
      h.mockChannel.onmessage({ data: { type: 'PRIMARY_CHECK', token: 'not-ours' } });
      expect(h.mockChannel.postMessage).not.toHaveBeenCalled();
    });

    test('a forged PRIMARY_ALIVE cannot make a tab adopt a foreign tag', async () => {
      const victim = new SocketIOProxy('victim-channel', 'ws://test-url');
      const original = getToken(victim);

      h.mockChannel.postMessage.mockImplementation((posted: any) => {
        if (posted.type === 'PRIMARY_CHECK' && h.mockChannel.onmessage) {
          h.mockChannel.onmessage({
            data: {
              type: 'PRIMARY_ALIVE',
              token: 'attacker-controlled',
              data: { tabId: 'zz', connected: true, active: true, id: 'evil' },
            },
          });
        }
      });

      const promise = victim.initialize();
      jest.advanceTimersByTime(2000);
      await promise;

      expect(getToken(victim)).toBe(original);
      expect(victim.isPrimary).toBe(true);
      expect(victim.id).not.toBe('evil');
    });

    test('messages with the correct tag are accepted', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      h.mockChannel.onmessage({
        data: { type: 'EVENT', data: { event: 'test-event', args: ['payload'] }, token: getToken(socketProxy) },
      });
      expect(callback).toHaveBeenCalledWith('payload');
    });
  });

  describe('initialize', () => {
    test('becomes primary when nothing answers', async () => {
      await electAsPrimary(socketProxy);
      expect(socketProxy.isPrimary).toBe(true);
    });

    test('becomes secondary when a primary answers', async () => {
      respondAsPrimary(h.mockChannel, socketProxy);
      await socketProxy.initialize();
      expect(socketProxy.isPrimary).toBe(false);
    });

    test('is idempotent — repeat calls share one election', async () => {
      const first = socketProxy.initialize();
      const second = socketProxy.initialize();
      expect(first).toBe(second);

      jest.advanceTimersByTime(2000);
      await Promise.all([first, second]);

      expect(socketProxy.isPrimary).toBe(true);
      expect(io).toHaveBeenCalledTimes(1);

      const checks = h.mockChannel.postMessage.mock.calls
        .map((c: any[]) => c[0])
        .filter((m: any) => m.type === 'PRIMARY_CHECK');
      expect(checks).toHaveLength(1);
    });

    test('honours a custom electionTimeout', async () => {
      const fast = new SocketIOProxy('fast-channel', 'ws://test-url', { electionTimeout: 200 });
      const promise = fast.initialize();

      jest.advanceTimersByTime(199);
      expect(fast.isPrimary).toBe(false);

      jest.advanceTimersByTime(1);
      await promise;
      expect(fast.isPrimary).toBe(true);
    });

    test('election jitter is bounded by electionJitter', async () => {
      (Math.random as jest.Mock).mockReturnValue(0.999999);
      const jittered = new SocketIOProxy('jitter-channel', 'ws://test-url', {
        electionTimeout: 1000,
        electionJitter: 100,
      });
      const promise = jittered.initialize();

      jest.advanceTimersByTime(1099);
      expect(jittered.isPrimary).toBe(false);

      jest.advanceTimersByTime(1);
      await promise;
      expect(jittered.isPrimary).toBe(true);
    });

    test('messages arriving before initialize() are still handled', () => {
      // The handler is installed in the constructor, so nothing is dropped
      // while the election is pending.
      const callback = jest.fn();
      socketProxy.on('early', callback);
      h.mockChannel.onmessage({
        data: { type: 'EVENT', data: { event: 'early', args: ['x'] }, token: getToken(socketProxy) },
      });
      expect(callback).toHaveBeenCalledWith('x');
    });

    test('adopting state during the handshake does not fire the event', async () => {
      // It lands mid-initialize(), before the caller could have subscribed; the
      // getters carry it the moment initialize() resolves.
      const fresh = new SocketIOProxy('quiet-channel', 'ws://test-url');
      const listener = jest.fn();
      fresh.on(SocketIOProxy.CONNECTION_STATE_EVENT, listener);

      await joinAsSecondary(h.mockChannel, fresh, { connected: true, active: true, id: 'live-id' });

      expect(listener).not.toHaveBeenCalled();
      expect(fresh.connected).toBe(true);
      expect(fresh.id).toBe('live-id');
    });

    test('adopts the primary state carried by PRIMARY_ALIVE', async () => {
      const fresh = new SocketIOProxy('state-channel', 'ws://test-url');
      await joinAsSecondary(h.mockChannel, fresh, { connected: true, active: true, id: 'live-id' });

      expect(fresh.isPrimary).toBe(false);
      expect(fresh.connected).toBe(true);
      expect(fresh.active).toBe(true);
      expect(fresh.id).toBe('live-id');
    });
  });

  describe('connection intent', () => {
    test('defaults to connected', () => {
      expect(socketProxy.wantsConnection).toBe(true);
    });

    test('autoConnect: false seeds it disconnected', () => {
      const deferred = new SocketIOProxy('deferred', 'ws://test-url', { autoConnect: false });
      expect(deferred.wantsConnection).toBe(false);
    });

    test('autoConnect is still handed to socket.io', async () => {
      const deferred = new SocketIOProxy('deferred', 'ws://test-url', { autoConnect: false });
      await electAsPrimary(deferred);

      expect(io).toHaveBeenCalledWith(
        'ws://test-url',
        expect.objectContaining({ autoConnect: false })
      );
    });

    test('promotion does not open a socket nobody asked for', async () => {
      const deferred = new SocketIOProxy('deferred', 'ws://test-url', { autoConnect: false });
      await electAsPrimary(deferred);

      expect(deferred.isPrimary).toBe(true);
      expect(h.mockSocket.connect).not.toHaveBeenCalled();
      expect(deferred.connected).toBe(false);
    });

    test('promotion opens the socket once the intent is there', async () => {
      const deferred = new SocketIOProxy('deferred', 'ws://test-url', { autoConnect: false });
      await electAsPrimary(deferred);
      expect(h.mockSocket.connect).not.toHaveBeenCalled();

      deferred.connect();

      expect(h.mockSocket.connect).toHaveBeenCalled();
      expect(deferred.wantsConnection).toBe(true);
    });

    test('closes a socket a cached Manager opened against the channel wishes', async () => {
      // io() caches Managers by url, so a Manager built elsewhere with
      // autoConnect true will open this socket no matter what we pass.
      (io as jest.Mock).mockImplementation(() => h.mockSocket);
      h.mockSocket.connected = true;
      h.mockSocket.active = true;

      const deferred = new SocketIOProxy('deferred', 'ws://test-url', { autoConnect: false });
      await electAsPrimary(deferred);

      expect(h.mockSocket.disconnect).toHaveBeenCalled();
    });
  });

  describe('getters', () => {
    test('io returns the manager when primary', async () => {
      await electAsPrimary(socketProxy);
      expect(socketProxy.io).toBe(h.mockSocket.io);
    });

    test('io returns null when secondary', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);
      expect(socketProxy.io).toBeNull();
    });

    test('active returns socket.active when primary', async () => {
      await electAsPrimary(socketProxy);
      expect(socketProxy.active).toBe(true);
    });

    test('active returns the cached value when secondary', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      expect(socketProxy.active).toBe(false);
      (socketProxy as any).socketActive = true;
      expect(socketProxy.active).toBe(true);
    });

    test('id returns the socket id when primary', async () => {
      await electAsPrimary(socketProxy);
      expect(socketProxy.id).toBe('test-socket-id');
    });

    test('id returns the cached value when secondary', () => {
      (socketProxy as any).socketId = 'secondary-id';
      expect(socketProxy.id).toBe('secondary-id');
    });

    test('connected and disconnected stay opposites', async () => {
      await electAsPrimary(socketProxy);

      h.mockChannel.onmessage(connectionState(socketProxy, { connected: true }));
      expect(socketProxy.connected).toBe(true);
      expect(socketProxy.disconnected).toBe(false);

      h.mockChannel.onmessage(connectionState(socketProxy, { connected: false }));
      expect(socketProxy.connected).toBe(false);
      expect(socketProxy.disconnected).toBe(true);
    });
  });

  describe('debug option', () => {
    test('does not log when debug is false (default)', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await electAsPrimary(socketProxy);
      expect(logSpy).not.toHaveBeenCalled();
    });

    test('logs when debug is true', async () => {
      const debugProxy = new SocketIOProxy('debug-ch', 'ws://test-url', { debug: true });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await electAsPrimary(debugProxy);

      const logged = logSpy.mock.calls.map((c: any[]) => c.join(' '));
      expect(logged.some((line: string) => line.includes('Became primary'))).toBe(true);
    });

    test('logs rejected messages when debug is enabled', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const debugProxy = new SocketIOProxy('debug-channel', 'ws://test-url', { debug: true });
      await electAsPrimary(debugProxy);

      logSpy.mockClear();
      h.mockChannel.onmessage({ data: { type: 'BOGUS' } });
      expect(logSpy).toHaveBeenCalledWith(
        '[SocketIOProxy]',
        'BroadcastChannel message rejected:',
        expect.any(Array)
      );
    });
  });
});
