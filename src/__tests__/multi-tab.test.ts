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
  let warn: any;

  beforeEach(() => {
    ({ warn } = installFakes());
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

  describe('forced promotion', () => {
    test('three tabs: forcePrimary on the third leaves exactly one socket, owned by it', async () => {
      const [a, b, c] = [makeTab(), makeTab(), makeTab()];
      await electAsPrimary(a);
      await b.initialize();
      await c.initialize();
      expect(livePrimaries(a, b, c)).toEqual([a]);

      const promise = c.forcePrimary();
      jest.advanceTimersByTime(2500);
      await promise;

      expect(livePrimaries(a, b, c)).toEqual([c]);
      // a's socket was hung up, c opened one; exactly one is still live.
      expect(sockets.filter(s => !s.disconnect.mock.calls.length)).toHaveLength(1);

      // ...and the other two still receive relayed events.
      const onA = jest.fn();
      const onB = jest.fn();
      a.on('relayed', onA);
      b.on('relayed', onB);
      onAnyOf(c)('relayed', 'payload');
      expect(onA).toHaveBeenCalledWith('payload');
      expect(onB).toHaveBeenCalledWith('payload');
    });

    test('repeated handovers never leave a stuck or duplicated primary', async () => {
      const tabs = [makeTab(), makeTab(), makeTab()];
      await electAsPrimary(tabs[0]);
      await tabs[1].initialize();
      await tabs[2].initialize();

      for (let i = 0; i < 10; i++) {
        const target = tabs[i % 3];
        const promise = target.forcePrimary();
        jest.advanceTimersByTime(2500);
        await promise;

        expect(livePrimaries(...tabs)).toEqual([target]);
      }
    });

    test('a forced promotion survives a stale primary with a higher tabId', async () => {
      const [a, b] = [makeTab(), makeTab()];
      await electAsPrimary(a);
      await b.initialize();

      const loser = tabIdOf(a) > tabIdOf(b) ? a : b;
      const winner = loser === a ? b : a;

      // Whichever tab holds the LOWER tabId demands the socket: under the old
      // tabId-only tie-break the other would have claimed it straight back.
      const demander = tabIdOf(a) < tabIdOf(b) ? a : b;
      const promise = demander.forcePrimary();
      jest.advanceTimersByTime(2500);
      await promise;

      expect(livePrimaries(a, b)).toEqual([demander]);
      void winner; void loser;
    });

    test('a secondary keeps its listeners across a forced promotion', async () => {
      const [a, b] = [makeTab(), makeTab()];
      await electAsPrimary(a);
      await b.initialize();

      const callback = jest.fn();
      b.on('after-promotion', callback);

      const promise = b.forcePrimary();
      jest.advanceTimersByTime(2500);
      await promise;

      onAnyOf(b)('after-promotion', 'ok');
      expect(callback).toHaveBeenCalledWith('ok');
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

  /**
   * With the default autoConnect, `io()` opens the socket itself and promotion
   * needs no help. With autoConnect false nothing else ever opens it, so a tab
   * promoted by failover used to hold a socket that never connected — no error,
   * no connect_error, `connected` false forever, because nothing was attempted.
   *
   * Intent is channel-wide rather than per-tab: the tab that gets promoted is
   * usually not the tab the consumer called connect() on.
   */
  describe('deferred connections (autoConnect: false)', () => {
    const deferred = { autoConnect: false };

    /** Two settled tabs on a channel that has not opened its socket yet. */
    async function twoDeferredTabs() {
      const primary = makeTab('deferred', deferred);
      await electAsPrimary(primary);
      const secondary = makeTab('deferred', deferred);
      await secondary.initialize();
      return { primary, secondary };
    }

    /** Announced departure, then long enough for the election to settle. */
    function killPrimary(primary: SocketIOProxy) {
      primary.closeChannel();
      jest.advanceTimersByTime(2500);
    }

    test('nothing opens the socket until the consumer asks', async () => {
      const { primary } = await twoDeferredTabs();

      expect(sockets).toHaveLength(1);
      expect(sockets[0].connect).not.toHaveBeenCalled();
      expect(primary.connected).toBe(false);
      expect(primary.wantsConnection).toBe(false);
    });

    test('a promoted tab opens its socket because another tab asked for it', async () => {
      const { primary, secondary } = await twoDeferredTabs();

      // Called once, on the tab that is about to die.
      primary.connect();
      expect(secondary.wantsConnection).toBe(true);

      killPrimary(primary);

      expect(secondary.isPrimary).toBe(true);
      expect(sockets).toHaveLength(2);
      expect(sockets[1].connect).toHaveBeenCalled();
      expect(secondary.connected).toBe(true);
    });

    test('a promoted tab stays closed when nobody asked — autoConnect is honoured', async () => {
      const { primary, secondary } = await twoDeferredTabs();

      killPrimary(primary);

      expect(secondary.isPrimary).toBe(true);
      expect(sockets).toHaveLength(2);
      expect(sockets[1].connect).not.toHaveBeenCalled();
      expect(secondary.connected).toBe(false);
    });

    test('a promoted tab does not reopen a connection the consumer closed', async () => {
      const { primary, secondary } = await twoDeferredTabs();

      primary.connect();
      primary.disconnect();
      expect(secondary.wantsConnection).toBe(false);

      killPrimary(primary);

      expect(secondary.isPrimary).toBe(true);
      expect(sockets[1].connect).not.toHaveBeenCalled();
      expect(secondary.connected).toBe(false);
    });

    test('a silent death is no different from an announced one', async () => {
      const { primary, secondary } = await twoDeferredTabs();
      primary.connect();

      // No PRIMARY_LEAVING at all: the heartbeat monitor drives this one.
      (primary as any).stopHeartbeat();
      (primary as any).channel.close();
      jest.advanceTimersByTime(13000);
      jest.advanceTimersByTime(2500);

      expect(secondary.isPrimary).toBe(true);
      expect(sockets[1].connect).toHaveBeenCalled();
    });

    test('forcePrimary() hands over a connection without a following connect()', async () => {
      const { primary, secondary } = await twoDeferredTabs();
      primary.connect();

      const promise = secondary.forcePrimary();
      jest.advanceTimersByTime(2500);
      await promise;

      expect(secondary.isPrimary).toBe(true);
      // The consumer's next line is an emit, not a connect.
      expect(sockets[1].connect).toHaveBeenCalled();
      expect(secondary.active).toBe(true);
    });

    test('connect() on a secondary reaches the primary and the whole channel', async () => {
      const { primary, secondary } = await twoDeferredTabs();

      secondary.connect();

      expect(sockets[0].connect).toHaveBeenCalled();
      expect(primary.connected).toBe(true);
      expect(primary.wantsConnection).toBe(true);
      expect(secondary.connected).toBe(true);
    });

    test('a newcomer does not drag a deliberately-offline channel online', async () => {
      // Only two tabs here, so the survivor of the election is unambiguous.
      const primary = makeTab('deferred', deferred);
      await electAsPrimary(primary);

      // Default options: this tab's own autoConnect says "connect me".
      const newcomer = makeTab('deferred');
      await newcomer.initialize();

      // ...but the channel has already decided otherwise.
      expect(newcomer.wantsConnection).toBe(false);
      expect(newcomer.isPrimary).toBe(false);
      expect(sockets).toHaveLength(1);

      killPrimary(primary);
      expect(newcomer.isPrimary).toBe(true);
      expect(sockets[1].connect).not.toHaveBeenCalled();
    });

    test('intent survives demotion, so a re-promoted tab reconnects', async () => {
      const { primary, secondary } = await twoDeferredTabs();
      primary.connect();

      // secondary takes over, then hands back to a third tab, then takes over
      // again — intent must not be lost anywhere along the way.
      const first = secondary.forcePrimary();
      jest.advanceTimersByTime(2500);
      await first;

      const back = primary.forcePrimary();
      jest.advanceTimersByTime(2500);
      await back;

      expect(primary.isPrimary).toBe(true);
      expect(primary.wantsConnection).toBe(true);
      expect(sockets[sockets.length - 1].connect).toHaveBeenCalled();
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

    test('peers().emit reaches the server once and the sibling tab, not the sender', () => {
      // The spec's acceptance criterion for A3, and the subtlest of them.
      const onPrimary = jest.fn();
      const onSecondary = jest.fn();
      primary.on('leave-room', onPrimary);
      secondary.on('leave-room', onSecondary);

      secondary.peers().emit('leave-room', 'room-1');

      expect(sockets[0].emit).toHaveBeenCalledTimes(1);
      expect(sockets[0].emit).toHaveBeenCalledWith('leave-room', 'room-1');
      expect(onPrimary).toHaveBeenCalledTimes(1);
      expect(onPrimary).toHaveBeenCalledWith('room-1');
      expect(onSecondary).not.toHaveBeenCalled();
    });

    test('reconnect_failed fires exactly once in every tab', () => {
      // The spec's acceptance criterion for A2.
      const onPrimary = jest.fn();
      const onSecondary = jest.fn();
      primary.on('reconnect_failed', onPrimary);
      secondary.on('reconnect_failed', onSecondary);

      const call = sockets[0].io.on.mock.calls.find((c: any[]) => c[0] === 'reconnect_failed');
      expect(call).toBeDefined();
      call[1]();

      expect(onPrimary).toHaveBeenCalledTimes(1);
      expect(onSecondary).toHaveBeenCalledTimes(1);
    });

    test('directChannelEmit reaches the other tabs but not the sender', () => {
      const onPrimary = jest.fn();
      const onSecondary = jest.fn();
      primary.on('local-update', onPrimary);
      secondary.on('local-update', onSecondary);

      primary.directChannelEmit('local-update', { cached: true });

      expect(onSecondary).toHaveBeenCalledWith({ cached: true });
      expect(onPrimary).not.toHaveBeenCalled();
    });

    test('connectionUpdate() with no socket event in flight reaches every secondary', () => {
      // A7's acceptance criterion: the primary pushes state that socket.io will
      // never announce, and secondaries learn about it by subscribing.
      const second = makeTab();
      void second.initialize();
      jest.advanceTimersByTime(0);

      const onSecondary = jest.fn();
      const onSecond = jest.fn();
      secondary.on(SocketIOProxy.CONNECTION_STATE_EVENT, onSecondary);
      second.on(SocketIOProxy.CONNECTION_STATE_EVENT, onSecond);

      // The socket is inactive, so disconnect() would emit nothing at all.
      sockets[0].connected = false;
      sockets[0].active = false;
      sockets[0].id = undefined;
      primary.connectionUpdate();

      const expected = { connected: false, id: undefined, active: false, wantsConnection: true };
      expect(onSecondary).toHaveBeenCalledTimes(1);
      expect(onSecondary).toHaveBeenCalledWith(expected);
      expect(onSecond).toHaveBeenCalledTimes(1);
      expect(onSecond).toHaveBeenCalledWith(expected);

      // ...and the getters agree, so neither polling nor the payload is wrong.
      expect(secondary.connected).toBe(false);
      expect(secondary.id).toBeUndefined();
      expect(secondary.active).toBe(false);
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

    test('a drifted identity is reported, not left silent', () => {
      // The classic drift, end to end: one service passes displayName and its
      // sibling does not, so the two silently open two sockets.
      const withName = makeTab('rtc', { auth: { user: 'u', token: 't', displayName: 'U' } });
      const without = makeTab('rtc', { auth: { user: 'u', token: 't' } });

      expect(withName.channelName).not.toBe(without.channelName);
      expect(warn).toHaveBeenCalled();
      const text = warn.mock.calls.map((c: any[]) => c.join(' ')).join(' | ');
      expect(text).toContain('auth.displayName');
      expect(text).toContain('"rtc"');
    });

    test('both sides of a drifted pair are told, whichever started first', () => {
      makeTab('rtc', { auth: { user: 'u', token: 't', displayName: 'U' } });
      warn.mockClear();
      // The newcomer announces; the tab already running answers, so the
      // newcomer learns about it too rather than only the other way round.
      makeTab('rtc', { auth: { user: 'u', token: 't' } });

      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('two genuinely different users are not warned about', () => {
      const userA = makeTab('rtc', { auth: { user: 'a', token: 't1' } });
      const userB = makeTab('rtc', { auth: { user: 'b', token: 't2' } });

      // Separate connections, which is the point — and no false alarm.
      expect(userA.channelName).not.toBe(userB.channelName);
      expect(warn).not.toHaveBeenCalled();
    });

    test('matching identities neither warn nor split', () => {
      const a = makeTab('rtc', { auth: { user: 'u', token: 't' } });
      const b = makeTab('rtc', { auth: { user: 'u', token: 't' } });

      expect(a.channelName).toBe(b.channelName);
      expect(warn).not.toHaveBeenCalled();
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
