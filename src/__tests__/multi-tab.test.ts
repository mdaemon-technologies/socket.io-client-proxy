import SocketIOProxy from '../socket-io-proxy';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  AnySocket,
  BusHarness,
  installFakes,
  installBus,
  restoreFakes,
  tabIdOf,
  electAsPrimary,
} from './helpers/harness';

jest.mock('socket.io-client');

/**
 * These specs run several proxies against a BroadcastChannel bus that really
 * routes messages between them, so elections, split brain and failover are
 * exercised end to end rather than simulated one tab at a time.
 */
describe('multi-tab behaviour', () => {
  let bus: BusHarness['bus'];
  let sockets: AnySocket[];

  beforeEach(() => {
    installFakes();
    ({ bus, sockets } = installBus());
  });

  afterEach(restoreFakes);

  function makeTab(id = 'shared', options = {}) {
    return new SocketIOProxy(id, 'ws://test-url', options);
  }

  function livePrimaries(...tabs: SocketIOProxy[]) {
    return tabs.filter(t => t.isPrimary);
  }

  function onAnyOf(proxy: SocketIOProxy) {
    return (proxy as any).socket.onAny.mock.calls[0][0] as (...args: any[]) => void;
  }

  describe('election', () => {
    test('a second tab joining an established primary becomes a secondary', async () => {
      const first = makeTab();
      await electAsPrimary(first);
      expect(first.isPrimary).toBe(true);

      const second = makeTab();
      await second.initialize();

      expect(second.isPrimary).toBe(false);
      expect(second.connected).toBe(true);
      expect(second.id).toBe('socket-1');
      expect(sockets).toHaveLength(1);
    });

    test('simultaneous starts converge on exactly one primary', async () => {
      const a = makeTab();
      const b = makeTab();
      const c = makeTab();

      const promises = [a.initialize(), b.initialize(), c.initialize()];
      jest.advanceTimersByTime(2500);
      await Promise.all(promises);

      expect(livePrimaries(a, b, c)).toHaveLength(1);
    });

    test('tabs that all promote themselves reconcile to one primary', async () => {
      const a = makeTab();
      const b = makeTab();

      // Buffer the channel so neither tab sees the other before promoting —
      // this is the split brain that a per-tab token made unrecoverable.
      bus.pause();
      const promises = [a.initialize(), b.initialize()];
      jest.advanceTimersByTime(2500);
      await Promise.all(promises);

      expect(a.isPrimary).toBe(true);
      expect(b.isPrimary).toBe(true);

      bus.flush();

      const winners = livePrimaries(a, b);
      expect(winners).toHaveLength(1);
      // The higher tabId keeps the socket.
      expect(winners[0]).toBe(tabIdOf(a) > tabIdOf(b) ? a : b);
      // The loser hung up.
      expect(sockets.filter(s => !s.disconnect.mock.calls.length)).toHaveLength(1);
    });

    test('the loser of a split brain keeps working as a secondary', async () => {
      const a = makeTab();
      const b = makeTab();

      bus.pause();
      const promises = [a.initialize(), b.initialize()];
      jest.advanceTimersByTime(2500);
      await Promise.all(promises);
      bus.flush();

      const winner = a.isPrimary ? a : b;
      const loser = a.isPrimary ? b : a;

      const callback = jest.fn();
      loser.on('news', callback);

      onAnyOf(winner)('news', 'from the winner');
      expect(callback).toHaveBeenCalledWith('from the winner');
    });

    test('a heartbeat reconciles a split brain even if the claim is lost', async () => {
      const a = makeTab();
      const b = makeTab();

      bus.pause();
      const promises = [a.initialize(), b.initialize()];
      jest.advanceTimersByTime(2500);
      await Promise.all(promises);

      // Drop the buffered claims entirely, leaving only heartbeats to recover.
      bus.discard();
      expect(livePrimaries(a, b)).toHaveLength(2);

      jest.advanceTimersByTime(3000);
      expect(livePrimaries(a, b)).toHaveLength(1);
    });
  });

  describe('failover', () => {
    test('secondaries fail over when the primary announces departure', async () => {
      const primary = makeTab();
      await electAsPrimary(primary);

      const secondary = makeTab();
      await secondary.initialize();
      expect(secondary.isPrimary).toBe(false);

      primary.closeChannel();

      jest.advanceTimersByTime(2500);
      expect(secondary.isPrimary).toBe(true);
      expect(sockets).toHaveLength(2);
    });

    test('secondaries fail over when the primary dies silently', async () => {
      const primary = makeTab();
      await electAsPrimary(primary);

      const secondary = makeTab();
      await secondary.initialize();

      // Kill the primary without any announcement.
      (primary as any).stopHeartbeat();
      (primary as any).channel.close();

      jest.advanceTimersByTime(13000);
      jest.advanceTimersByTime(2500);
      expect(secondary.isPrimary).toBe(true);
    });

    test('exactly one of several secondaries takes over after a departure', async () => {
      const primary = makeTab();
      await electAsPrimary(primary);

      const secondaries = [makeTab(), makeTab(), makeTab()];
      for (const s of secondaries) {
        await s.initialize();
      }
      expect(livePrimaries(...secondaries)).toHaveLength(0);

      primary.closeChannel();
      jest.advanceTimersByTime(3000);

      expect(livePrimaries(...secondaries)).toHaveLength(1);
    });

    test('the new primary keeps serving the remaining tabs', async () => {
      const primary = makeTab();
      await electAsPrimary(primary);

      const a = makeTab();
      const b = makeTab();
      await a.initialize();
      await b.initialize();

      primary.closeChannel();
      jest.advanceTimersByTime(3000);

      const winner = [a, b].find(t => t.isPrimary)!;
      const follower = winner === a ? b : a;
      expect(winner).toBeDefined();
      expect(follower.isPrimary).toBe(false);

      const callback = jest.fn();
      follower.on('after-failover', callback);
      onAnyOf(winner)('after-failover', 'ok');

      expect(callback).toHaveBeenCalledWith('ok');
    });

  });

  describe('traffic between tabs', () => {
    let primary: SocketIOProxy;
    let secondary: SocketIOProxy;

    beforeEach(async () => {
      primary = makeTab();
      await electAsPrimary(primary);
      secondary = makeTab();
      await secondary.initialize();
    });

    test('emit from a secondary reaches the primary socket', () => {
      secondary.emit('chat', 'hello');
      expect(sockets[0].emit).toHaveBeenCalledWith('chat', 'hello');
    });

    test('socket events reach every tab', () => {
      const onSecondary = jest.fn();
      secondary.on('news', onSecondary);

      onAnyOf(primary)('news', 'broadcast');
      expect(onSecondary).toHaveBeenCalledWith('broadcast');
    });

    test('emitWithAck round-trips across tabs', async () => {
      sockets[0].emitWithAck.mockResolvedValue({ ok: true });

      const promise = secondary.emitWithAck('req', 1);
      await jest.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toEqual({ ok: true });
    });

    test('emitWithAck failures propagate across tabs', async () => {
      sockets[0].emitWithAck.mockRejectedValue(new Error('operation has timed out'));

      const promise = secondary.emitWithAck('req', 1);
      const assertion = expect(promise).rejects.toThrow('operation has timed out');
      await jest.advanceTimersByTimeAsync(0);
      await assertion;
    });

    test('sendMessageToPrimary reaches the primary subscriber', () => {
      const subscriber = jest.fn();
      primary.onProxyMessage('sync', subscriber);

      secondary.sendMessageToPrimary({ eventName: 'sync', message: { key: 'prefs' } });
      expect(subscriber).toHaveBeenCalledWith({ key: 'prefs' });
    });

    test('directChannelEmit reaches every tab including the sender', () => {
      const onPrimary = jest.fn();
      const onSecondary = jest.fn();
      primary.on('local-update', onPrimary);
      secondary.on('local-update', onSecondary);

      primary.directChannelEmit('local-update', { cached: true });

      expect(onPrimary).toHaveBeenCalledWith({ cached: true });
      expect(onSecondary).toHaveBeenCalledWith({ cached: true });
    });

    test('a secondary sees the primary disconnect and cleared id', () => {
      const onDisconnect = jest.fn();
      secondary.on('disconnect', onDisconnect);

      sockets[0].id = undefined;
      sockets[0].connected = false;
      sockets[0].active = false;
      const handler = sockets[0].on.mock.calls.find((c: any[]) => c[0] === 'disconnect')[1];
      handler('transport close');

      expect(onDisconnect).toHaveBeenCalledWith('transport close');
      expect(secondary.connected).toBe(false);
      expect(secondary.id).toBeUndefined();
    });
  });

  describe('connection-identity isolation', () => {
    test('tabs with different auth do not share a connection', async () => {
      const userA = makeTab('app', { auth: { token: 'user-a' } });
      await electAsPrimary(userA);

      const userB = makeTab('app', { auth: { token: 'user-b' } });
      await electAsPrimary(userB);

      // Each principal gets its own channel, and therefore its own socket.
      expect(userA.isPrimary).toBe(true);
      expect(userB.isPrimary).toBe(true);
      expect(sockets).toHaveLength(2);
    });

    test('a tab authenticated as another user cannot read the first socket traffic', async () => {
      const primary = makeTab('app', { auth: { token: 'user-a' } });
      await electAsPrimary(primary);

      const foreign = makeTab('app', { auth: { token: 'user-b' } });
      await electAsPrimary(foreign);

      const leaked = jest.fn();
      foreign.on('secret', leaked);

      onAnyOf(primary)('secret', 'user-a data');
      expect(leaked).not.toHaveBeenCalled();
    });

    test('a payload that cannot cross tabs fails at the call site', () => {
      // The bus uses real structured-clone semantics, so this is the same
      // failure a browser would produce rather than a silently mangled value.
      const a = makeTab('clone-check');
      expect(() => a.directChannelEmit('x', () => {})).toThrow();
      expect(() => a.directChannelEmit('x', { fine: true })).not.toThrow();
    });

    test('tabs on unrelated channel ids ignore each other', () => {
      const a = makeTab('app-one');
      const b = makeTab('app-two');
      const callback = jest.fn();
      b.on('x', callback);

      a.directChannelEmit('x', 1);
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
