import SocketIOProxy from '../socket-io-proxy';
import { io } from 'socket.io-client';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  Harness,
  installFakes,
  restoreFakes,
  tabIdOf,
  electAsPrimary,
  joinAsSecondary,
  msg,
  primaryAlive,
  primaryClaim,
  heartbeat,
  epochOf,
  connectionState,
} from './helpers/harness';

jest.mock('socket.io-client');

describe('election, failover and teardown', () => {
  let h: Harness;
  let socketProxy: SocketIOProxy;

  beforeEach(() => {
    h = installFakes();
    socketProxy = new SocketIOProxy('test-channel', 'ws://test-url');
  });

  afterEach(restoreFakes);

  describe('connect / disconnect delegation', () => {
    test('calls the socket directly when primary', async () => {
      await electAsPrimary(socketProxy);

      socketProxy.disconnect();
      expect(h.mockSocket.disconnect).toHaveBeenCalled();

      socketProxy.connect();
      expect(h.mockSocket.connect).toHaveBeenCalled();
    });

    test('posts DISCONNECT/CONNECT when secondary', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      socketProxy.disconnect();
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'DISCONNECT' })
      );

      h.mockChannel.postMessage.mockClear();
      socketProxy.connect();
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CONNECT' })
      );
    });
  });

  describe('heartbeat', () => {
    test('the primary broadcasts HEARTBEAT with its tabId at the configured interval', async () => {
      await electAsPrimary(socketProxy);

      h.mockChannel.postMessage.mockClear();
      jest.advanceTimersByTime(3000);
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'HEARTBEAT', data: { tabId: tabIdOf(socketProxy), epoch: epochOf(socketProxy) },
        })
      );
    });

    test('honours a custom heartbeatInterval', async () => {
      const customProxy = new SocketIOProxy('hb-channel', 'ws://test-url', { heartbeatInterval: 1000 });
      await electAsPrimary(customProxy);

      h.mockChannel.postMessage.mockClear();
      jest.advanceTimersByTime(1000);
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'HEARTBEAT' })
      );
    });

    test('a secondary starts a heartbeat monitor after the election', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);
      expect((socketProxy as any).heartbeatMonitorTimer).not.toBeNull();
    });

    test('a secondary re-elects when the heartbeat is lost', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);
      expect(socketProxy.isPrimary).toBe(false);

      jest.advanceTimersByTime(13000);
      jest.advanceTimersByTime(2000);
      expect(socketProxy.isPrimary).toBe(true);
    });

    test('heartbeats keep a secondary from re-electing', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      // A heartbeat every 5s keeps the 10s timeout from ever elapsing.
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(5000);
        h.mockChannel.onmessage(heartbeat(socketProxy));
      }

      expect(socketProxy.isPrimary).toBe(false);
    });

    test('traffic is still handled while a re-election is pending', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback = jest.fn();
      socketProxy.on('during-election', callback);

      // Push past the heartbeat timeout so an election is in flight...
      jest.advanceTimersByTime(13000);
      expect(socketProxy.isPrimary).toBe(false);

      // ...and confirm ordinary messages are not dropped meanwhile.
      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'EVENT', data: { event: 'during-election', args: ['kept'] },
      }));
      expect(callback).toHaveBeenCalledWith('kept');
    });

    test('a failing broadcast cannot kill the re-election timer', async () => {
      // A throw inside the monitor interval would take the tab down, and the
      // election promise nobody awaits would surface as an unhandled rejection.
      await joinAsSecondary(h.mockChannel, socketProxy);

      const onError = jest.fn();
      socketProxy.on(SocketIOProxy.PROXY_ERROR_EVENT, onError);
      h.mockChannel.postMessage.mockImplementation(() => {
        throw new Error('InvalidStateError');
      });

      expect(() => jest.advanceTimersByTime(13000)).not.toThrow();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'InvalidStateError' }),
        expect.stringContaining('PRIMARY_CHECK')
      );

      // The check never went out, so the fallback must still apply: this tab
      // promotes itself when the election times out.
      jest.advanceTimersByTime(2000);
      expect(socketProxy.isPrimary).toBe(true);
    });

    test('an in-flight election is abandoned when a primary announces itself', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      jest.advanceTimersByTime(13000);
      h.mockChannel.onmessage(primaryAlive(socketProxy, { connected: true, active: true, id: 'live' }));

      jest.advanceTimersByTime(5000);
      expect(socketProxy.isPrimary).toBe(false);
      expect(socketProxy.id).toBe('live');
    });
  });

  describe('duplicate primary detection', () => {
    beforeEach(async () => {
      await electAsPrimary(socketProxy);
    });

    test('broadcasts PRIMARY_CLAIM on becoming primary', () => {
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PRIMARY_CLAIM', data: { tabId: tabIdOf(socketProxy), epoch: epochOf(socketProxy) },
        })
      );
    });

    test('yields to a higher tabId on PRIMARY_CLAIM', () => {
      expect(socketProxy.isPrimary).toBe(true);

      h.mockChannel.onmessage(primaryClaim(socketProxy, { tabId: 'zz'.repeat(24), epoch: epochOf(socketProxy) }));
      expect(socketProxy.isPrimary).toBe(false);
      expect(h.mockSocket.disconnect).toHaveBeenCalled();
    });

    test('sends a targeted PRIMARY_YIELD to a lower tabId', () => {
      (socketProxy as any).tabId = 'zz'.repeat(24);
      h.mockChannel.postMessage.mockClear();

      const lowerTabId = '00'.repeat(24);
      h.mockChannel.onmessage(primaryClaim(socketProxy, { tabId: lowerTabId, epoch: epochOf(socketProxy) }));

      expect(socketProxy.isPrimary).toBe(true);
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIMARY_YIELD', data: { tabId: lowerTabId } })
      );
    });

    test('demotes on a PRIMARY_YIELD addressed to it', () => {
      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'PRIMARY_YIELD', data: { tabId: tabIdOf(socketProxy) },
      }));
      expect(socketProxy.isPrimary).toBe(false);
      expect(h.mockSocket.disconnect).toHaveBeenCalled();
    });

    test('ignores a PRIMARY_YIELD addressed to another tab', () => {
      // An untargeted yield used to demote every primary that saw it.
      h.mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_YIELD', data: { tabId: 'someone-else' } }));
      expect(socketProxy.isPrimary).toBe(true);
      expect(h.mockSocket.disconnect).not.toHaveBeenCalled();
    });

    test('a heartbeat from another primary triggers reconciliation', () => {
      // Backstop in case a PRIMARY_CLAIM is missed: the next heartbeat resolves it.
      h.mockChannel.onmessage(heartbeat(socketProxy, {
        tabId: 'zz'.repeat(24), epoch: epochOf(socketProxy),
      }));
      expect(socketProxy.isPrimary).toBe(false);
    });

    test('a PRIMARY_ALIVE from another primary triggers reconciliation', () => {
      h.mockChannel.onmessage(primaryAlive(socketProxy, {
        tabId: 'zz'.repeat(24), epoch: epochOf(socketProxy), connected: true, active: true, id: 'x',
      }));
      expect(socketProxy.isPrimary).toBe(false);
    });

    test('a primary that wins reconciliation does not adopt the loser state', () => {
      // Winning the tie-break must not leave this tab reporting a connection
      // it does not own.
      (socketProxy as any).tabId = 'zz'.repeat(24);
      (socketProxy as any).isConnected = true;

      h.mockChannel.onmessage(primaryAlive(socketProxy, {
        tabId: '00'.repeat(24), epoch: epochOf(socketProxy), connected: false, active: false, id: 'theirs',
      }));

      expect(socketProxy.isPrimary).toBe(true);
      expect(socketProxy.connected).toBe(true);
      expect(socketProxy.id).toBe('test-socket-id');
    });

    test('demotion keeps listeners registered while primary', () => {
      const callback = jest.fn();
      socketProxy.on('kept', callback);

      h.mockChannel.onmessage(primaryClaim(socketProxy, { tabId: 'zz'.repeat(24), epoch: epochOf(socketProxy) }));
      expect(socketProxy.isPrimary).toBe(false);

      h.mockChannel.onmessage(msg(socketProxy, { type: 'EVENT', data: { event: 'kept', args: ['still here'] } }));
      expect(callback).toHaveBeenCalledWith('still here');
    });

    test('a demoted tab still accepts traffic from the winner', () => {
      h.mockChannel.onmessage(primaryClaim(socketProxy, { tabId: 'zz'.repeat(24), epoch: epochOf(socketProxy) }));

      // The channel tag is shared, so there is no blackout while the demoted
      // tab waits to re-learn a token.
      h.mockChannel.onmessage(connectionState(socketProxy, { id: 'winner-id' }));
      expect(socketProxy.id).toBe('winner-id');
    });

    test('a discarded socket can no longer broadcast as primary', () => {
      // socket.io destroys the socket on disconnect, but a late event from the
      // one this tab let go of must never be relayed as if it still owned it.
      const onAnyHandler = h.mockSocket.onAny.mock.calls[0][0] as (...args: any[]) => void;

      h.mockChannel.onmessage(primaryClaim(socketProxy, { tabId: 'zz'.repeat(24), epoch: epochOf(socketProxy) }));
      expect(socketProxy.isPrimary).toBe(false);

      const local = jest.fn();
      socketProxy.on('zombie', local);
      h.mockChannel.postMessage.mockClear();

      onAnyHandler('zombie', 'from a dead socket');

      expect(h.mockChannel.postMessage).not.toHaveBeenCalled();
      expect(local).not.toHaveBeenCalled();
    });

    test('a demoted tab starts monitoring the winner heartbeat', () => {
      h.mockChannel.onmessage(primaryClaim(socketProxy, { tabId: 'zz'.repeat(24), epoch: epochOf(socketProxy) }));
      expect((socketProxy as any).heartbeatMonitorTimer).not.toBeNull();
      expect((socketProxy as any).heartbeatTimer).toBeNull();
    });
  });

  describe('forcePrimary', () => {
    function lastPosted(type: string) {
      return h.mockChannel.postMessage.mock.calls
        .map((c: any[]) => c[0])
        .reverse()
        .find((m: any) => m.type === type);
    }

    test('resolves immediately when this tab is already primary', async () => {
      await electAsPrimary(socketProxy);
      h.mockChannel.postMessage.mockClear();

      await socketProxy.forcePrimary();

      expect(socketProxy.isPrimary).toBe(true);
      expect(lastPosted('PRIMARY_DEMAND')).toBeUndefined();
    });

    test('broadcasts a demand and promotes when nobody answers', async () => {
      const promise = socketProxy.forcePrimary();
      expect(lastPosted('PRIMARY_DEMAND')).toEqual(
        expect.objectContaining({ data: { tabId: tabIdOf(socketProxy) } })
      );

      expect(socketProxy.isPrimary).toBe(false);
      jest.advanceTimersByTime(2000);
      await promise;

      expect(socketProxy.isPrimary).toBe(true);
    });

    test('promotes as soon as the old primary stands down', async () => {
      const promise = socketProxy.forcePrimary();

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'PRIMARY_STOOD_DOWN', data: { tabId: tabIdOf(socketProxy) },
      }));

      await promise;
      expect(socketProxy.isPrimary).toBe(true);
    });

    test('ignores a stand-down addressed to another tab', async () => {
      const promise = socketProxy.forcePrimary();

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'PRIMARY_STOOD_DOWN', data: { tabId: 'someone-else' },
      }));
      expect(socketProxy.isPrimary).toBe(false);

      jest.advanceTimersByTime(2000);
      await promise;
      expect(socketProxy.isPrimary).toBe(true);
    });

    test('concurrent calls share one demand and one promise', async () => {
      const a = socketProxy.forcePrimary();
      const b = socketProxy.forcePrimary();

      const demands = h.mockChannel.postMessage.mock.calls
        .map((c: any[]) => c[0])
        .filter((m: any) => m.type === 'PRIMARY_DEMAND');
      expect(demands).toHaveLength(1);

      jest.advanceTimersByTime(2000);
      await Promise.all([a, b]);
      expect(socketProxy.isPrimary).toBe(true);
      expect(io).toHaveBeenCalledTimes(1);
    });

    test('listeners registered before promotion still fire afterwards', async () => {
      const callback = jest.fn();
      socketProxy.on('kept', callback);

      const promise = socketProxy.forcePrimary();
      jest.advanceTimersByTime(2000);
      await promise;

      const onAnyHandler = h.mockSocket.onAny.mock.calls[0][0] as (...args: any[]) => void;
      onAnyHandler('kept', 'still here');
      expect(callback).toHaveBeenCalledWith('still here');
    });

    test('the promotion outranks a stale primary holding a higher tabId', async () => {
      // The whole point of the epoch: tabId alone would let the stale tab win
      // the tie-break and undo the forced promotion.
      const promise = socketProxy.forcePrimary();
      jest.advanceTimersByTime(2000);
      await promise;
      expect(socketProxy.isPrimary).toBe(true);

      h.mockChannel.postMessage.mockClear();
      h.mockChannel.onmessage(primaryClaim(socketProxy, {
        tabId: 'zz'.repeat(24), epoch: epochOf(socketProxy) - 1,
      }));

      expect(socketProxy.isPrimary).toBe(true);
      expect(lastPosted('PRIMARY_YIELD')).toEqual(
        expect.objectContaining({ data: { tabId: 'zz'.repeat(24) } })
      );
    });

    test('a primary stands down on a demand and says so', async () => {
      await electAsPrimary(socketProxy);
      h.mockChannel.postMessage.mockClear();

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'PRIMARY_DEMAND', data: { tabId: 'zz'.repeat(24) },
      }));

      expect(socketProxy.isPrimary).toBe(false);
      expect(h.mockSocket.disconnect).toHaveBeenCalled();
      expect(lastPosted('PRIMARY_STOOD_DOWN')).toEqual(
        expect.objectContaining({ data: { tabId: 'zz'.repeat(24) } })
      );
    });

    test('a tab that stood down does not immediately re-elect itself', async () => {
      await electAsPrimary(socketProxy);
      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'PRIMARY_DEMAND', data: { tabId: 'zz'.repeat(24) },
      }));
      h.mockChannel.postMessage.mockClear();

      // It waits out the heartbeat timeout like any other secondary.
      jest.advanceTimersByTime(2500);
      expect(socketProxy.isPrimary).toBe(false);
      expect(lastPosted('PRIMARY_CHECK')).toBeUndefined();
    });

    test('rejects after closeChannel', async () => {
      socketProxy.closeChannel();
      await expect(socketProxy.forcePrimary()).rejects.toThrow('after closeChannel() has been called');
    });
  });

  describe('primary departure', () => {
    test('announces PRIMARY_LEAVING on pagehide', async () => {
      await electAsPrimary(socketProxy);
      h.mockChannel.postMessage.mockClear();

      window.dispatchEvent(new Event('pagehide'));

      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIMARY_LEAVING', data: { tabId: tabIdOf(socketProxy) } })
      );
    });

    test('announces PRIMARY_LEAVING on beforeunload', async () => {
      await electAsPrimary(socketProxy);
      h.mockChannel.postMessage.mockClear();

      window.dispatchEvent(new Event('beforeunload'));

      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIMARY_LEAVING' })
      );
    });

    test('a secondary re-elects immediately instead of waiting out the timeout', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);
      expect(socketProxy.isPrimary).toBe(false);

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'PRIMARY_LEAVING', data: { tabId: 'ff'.repeat(24) },
      }));

      // Only the election delay, not the full heartbeatTimeout.
      jest.advanceTimersByTime(2000);
      expect(socketProxy.isPrimary).toBe(true);
    });

    test('closeChannel announces departure before closing', async () => {
      await electAsPrimary(socketProxy);
      h.mockChannel.postMessage.mockClear();

      socketProxy.closeChannel();

      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIMARY_LEAVING' })
      );
      expect(h.mockChannel.close).toHaveBeenCalled();
    });

    test('a demoted tab stops announcing departures', async () => {
      await electAsPrimary(socketProxy);
      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'PRIMARY_YIELD', data: { tabId: tabIdOf(socketProxy) },
      }));
      h.mockChannel.postMessage.mockClear();

      window.dispatchEvent(new Event('pagehide'));
      expect(h.mockChannel.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('closeChannel', () => {
    test('closes the channel', () => {
      socketProxy.closeChannel();
      expect(h.mockChannel.close).toHaveBeenCalled();
    });

    test('is idempotent', () => {
      socketProxy.closeChannel();
      socketProxy.closeChannel();
      expect(h.mockChannel.close).toHaveBeenCalledTimes(1);
    });

    test('stops the heartbeat timers', async () => {
      await electAsPrimary(socketProxy);

      socketProxy.closeChannel();
      expect((socketProxy as any).heartbeatTimer).toBeNull();
      expect((socketProxy as any).heartbeatMonitorTimer).toBeNull();
    });

    test('clears primary state so later calls cannot post on a closed channel', async () => {
      await electAsPrimary(socketProxy);
      socketProxy.closeChannel();

      expect(socketProxy.isPrimary).toBe(false);
      expect(socketProxy.connected).toBe(false);
      expect(socketProxy.active).toBe(false);
    });

    test('public methods throw a clear error afterwards', () => {
      socketProxy.closeChannel();

      expect(() => socketProxy.emit('x')).toThrow('after closeChannel() has been called');
      expect(() => socketProxy.connect()).toThrow('after closeChannel() has been called');
      expect(() => socketProxy.disconnect()).toThrow('after closeChannel() has been called');
      expect(() => socketProxy.directChannelEmit('x')).toThrow('after closeChannel() has been called');
      expect(() => socketProxy.sendMessageToPrimary({ eventName: 'x' }))
        .toThrow('after closeChannel() has been called');
    });

    test('emitWithAck rejects afterwards', async () => {
      socketProxy.closeChannel();
      await expect(socketProxy.emitWithAck('x')).rejects.toThrow('after closeChannel() has been called');
    });

    test('rejects pending acks rather than leaving callers hanging', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const pending = socketProxy.emitWithAck('slow');
      socketProxy.closeChannel();

      await expect(pending).rejects.toThrow('BroadcastChannel closed before the primary responded');
    });

    test('detaches the message handler', () => {
      socketProxy.closeChannel();
      expect(h.mockChannel.onmessage).toBeNull();
    });

    test('resolves a pending initialize()', async () => {
      const promise = socketProxy.initialize();
      socketProxy.closeChannel();
      await expect(promise).resolves.toBeUndefined();
      expect(socketProxy.isPrimary).toBe(false);
    });

    test('releases listeners and subscribers', async () => {
      await electAsPrimary(socketProxy);
      socketProxy.on('x', jest.fn());
      socketProxy.onProxyMessage('y', jest.fn());
      socketProxy.onPrimaryCheck(jest.fn());

      socketProxy.closeChannel();

      expect((socketProxy as any).listeners.size).toBe(0);
      expect((socketProxy as any).messageSubscribers.size).toBe(0);
      expect((socketProxy as any).primaryCheckSubscribers.size).toBe(0);
      expect(socketProxy.id).toBeUndefined();
    });

    test('disconnects the socket when primary', async () => {
      await electAsPrimary(socketProxy);
      socketProxy.closeChannel();
      expect(h.mockSocket.disconnect).toHaveBeenCalled();
    });
  });
});
