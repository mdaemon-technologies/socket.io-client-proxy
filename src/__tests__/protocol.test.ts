import SocketIOProxy from '../socket-io-proxy';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  Harness,
  installFakes,
  restoreFakes,
  getToken,
  tabIdOf,
  socketHandler,
  electAsPrimary,
  joinAsSecondary,
  msg,
} from './helpers/harness';

jest.mock('socket.io-client');

describe('wire protocol', () => {
  let h: Harness;
  let socketProxy: SocketIOProxy;

  beforeEach(() => {
    h = installFakes();
    socketProxy = new SocketIOProxy('test-channel', 'ws://test-url');
  });

  afterEach(restoreFakes);

  describe('primary lifecycle forwarding', () => {
    beforeEach(async () => {
      await electAsPrimary(socketProxy);
    });

    test('forwards connect to secondaries and local listeners', () => {
      const callback = jest.fn();
      socketProxy.on('connect', callback);
      h.mockChannel.postMessage.mockClear();

      socketHandler(h.mockSocket, 'connect')();

      expect(callback).toHaveBeenCalled();
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'EVENT', data: { event: 'connect', args: [] } })
      );
    });

    test('forwards disconnect with its reason', () => {
      const callback = jest.fn();
      socketProxy.on('disconnect', callback);
      h.mockChannel.postMessage.mockClear();

      socketHandler(h.mockSocket, 'disconnect')('transport close');

      expect(callback).toHaveBeenCalledWith('transport close');
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'EVENT', data: { event: 'disconnect', args: ['transport close'] } })
      );
    });

    test('forwards connect_error, which onAny never sees', () => {
      const callback = jest.fn();
      socketProxy.on('connect_error', callback);
      h.mockChannel.postMessage.mockClear();

      const error = new Error('xhr poll error');
      socketHandler(h.mockSocket, 'connect_error')(error);

      // Local listeners get the real Error...
      expect(callback).toHaveBeenCalledWith(error);
      // ...peers get a cloneable message, since Errors do not survive intact.
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'EVENT', data: { event: 'connect_error', args: ['xhr poll error'] } })
      );
    });

    test('broadcasts socket id and active state on connect', () => {
      h.mockChannel.postMessage.mockClear();
      socketHandler(h.mockSocket, 'connect')();

      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SOCKET_ID_UPDATE', data: { id: 'test-socket-id' } })
      );
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ACTIVE_STATUS_UPDATE', data: { active: true } })
      );
    });

    test('a cleared socket id is broadcast as a sentinel that validates', () => {
      // socket.io deletes `id` on close; sending `undefined` would fail schema
      // validation and leave every secondary holding a stale id.
      h.mockSocket.id = undefined;
      h.mockSocket.connected = false;
      h.mockSocket.active = false;
      h.mockChannel.postMessage.mockClear();

      socketHandler(h.mockSocket, 'disconnect')('transport close');

      const idUpdate = h.mockChannel.postMessage.mock.calls
        .map((c: any[]) => c[0])
        .find((m: any) => m.type === 'SOCKET_ID_UPDATE');
      expect(idUpdate.data.id).toBe('');
    });

    test('a payload that cannot be cloned surfaces as proxy_error, not a throw', () => {
      // Throwing here would escape into socket.io's dispatch loop and break
      // event delivery for the whole tab.
      const onError = jest.fn();
      socketProxy.on(SocketIOProxy.PROXY_ERROR_EVENT, onError);
      const local = jest.fn();
      socketProxy.on('bulky', local);

      h.mockChannel.postMessage.mockImplementation(() => {
        throw new Error('could not be cloned');
      });

      const onAnyHandler = h.mockSocket.onAny.mock.calls[0][0] as (...args: any[]) => void;
      expect(() => onAnyHandler('bulky', () => {})).not.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'could not be cloned' }),
        expect.stringContaining('bulky')
      );
      // Local delivery still happens even though the broadcast failed.
      expect(local).toHaveBeenCalled();
    });

    test('a peer accepts the sentinel and clears its cached id', () => {
      const peer = new SocketIOProxy('test-channel', 'ws://test-url');
      (peer as any).socketId = 'stale-id';
      h.mockChannel.onmessage(msg(peer, { type: 'SOCKET_ID_UPDATE', data: { id: '' } }));
      expect(peer.id).toBeUndefined();
    });
  });

  describe('primary handles commands from secondary tabs', () => {
    beforeEach(async () => {
      await electAsPrimary(socketProxy);
    });

    test('answers PRIMARY_CHECK with PRIMARY_ALIVE carrying its state', () => {
      h.mockChannel.postMessage.mockClear();
      h.mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_CHECK' }));

      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PRIMARY_ALIVE',
          data: { tabId: tabIdOf(socketProxy), connected: true, active: true, id: 'test-socket-id' },
        })
      );
    });

    test('PRIMARY_CHECK no longer broadcasts a synthetic connect to every tab', () => {
      h.mockChannel.postMessage.mockClear();
      h.mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_CHECK' }));

      const events = h.mockChannel.postMessage.mock.calls
        .map((c: any[]) => c[0])
        .filter((m: any) => m.type === 'EVENT');
      expect(events).toHaveLength(0);
    });

    test('forwards EMIT to the socket', () => {
      h.mockChannel.onmessage(msg(socketProxy, { type: 'EMIT', data: { event: 'msg', args: ['hello'] } }));
      expect(h.mockSocket.emit).toHaveBeenCalledWith('msg', 'hello');
    });

    test('applies forwarded timeout and volatile flags', () => {
      const volatileEmit = jest.fn();
      h.mockSocket.timeout.mockReturnValue({ volatile: { emit: volatileEmit } });

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'EMIT', data: { event: 'x', args: ['a'], timeout: 500, volatile: true },
      }));

      expect(h.mockSocket.timeout).toHaveBeenCalledWith(500);
      expect(volatileEmit).toHaveBeenCalledWith('x', 'a');
    });

    test('ignores an out-of-range forwarded timeout', () => {
      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'EMIT', data: { event: 'x', args: [], timeout: -5 },
      }));

      expect(h.mockSocket.timeout).not.toHaveBeenCalled();
      expect(h.mockSocket.emit).toHaveBeenCalledWith('x');
    });

    test('forwards EMIT_WITH_ACK and broadcasts the response', async () => {
      const ackResponse = { ok: true };
      h.mockSocket.emitWithAck.mockResolvedValue(ackResponse);

      h.mockChannel.postMessage.mockClear();
      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'EMIT_WITH_ACK', data: { event: 'req', args: ['x'], id: 'abc123' },
      }));

      await jest.advanceTimersByTimeAsync(0);

      expect(h.mockSocket.emitWithAck).toHaveBeenCalledWith('req', 'x');
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT_WITH_ACK_RESPONSE', data: { id: 'abc123', response: ackResponse },
        })
      );
    });

    test('applies forwarded flags to a forwarded EMIT_WITH_ACK', async () => {
      const emitWithAck = jest.fn<any>().mockResolvedValue('acked');
      h.mockSocket.timeout.mockReturnValue({ emitWithAck });
      h.mockChannel.postMessage.mockClear();

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'EMIT_WITH_ACK', data: { event: 'req', args: ['x'], id: 'f1', timeout: 250 },
      }));
      await jest.advanceTimersByTimeAsync(0);

      expect(h.mockSocket.timeout).toHaveBeenCalledWith(250);
      expect(emitWithAck).toHaveBeenCalledWith('req', 'x');
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT_WITH_ACK_RESPONSE', data: { id: 'f1', response: 'acked' },
        })
      );
    });

    test('broadcasts an error response when emitWithAck rejects', async () => {
      h.mockSocket.emitWithAck.mockRejectedValue(new Error('socket error'));
      h.mockChannel.postMessage.mockClear();

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'EMIT_WITH_ACK', data: { event: 'fail', args: [], id: 'err-id' },
      }));
      await jest.advanceTimersByTimeAsync(0);

      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT_WITH_ACK_RESPONSE',
          data: expect.objectContaining({ id: 'err-id', error: 'socket error' }),
        })
      );
    });

    test('calls socket.disconnect on DISCONNECT', () => {
      h.mockChannel.onmessage(msg(socketProxy, { type: 'DISCONNECT' }));
      expect(h.mockSocket.disconnect).toHaveBeenCalled();
    });

    test('calls socket.connect on CONNECT', () => {
      h.mockChannel.onmessage(msg(socketProxy, { type: 'CONNECT' }));
      expect(h.mockSocket.connect).toHaveBeenCalled();
    });

    test('publishes on MESSAGE_TO_PRIMARY', () => {
      const subscriber = jest.fn();
      socketProxy.onProxyMessage('chat', subscriber);

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'MESSAGE_TO_PRIMARY', data: { eventName: 'chat', message: 'hi' },
      }));
      expect(subscriber).toHaveBeenCalledWith('hi');
    });
  });

  describe('secondary handles broadcasts from primary', () => {
    beforeEach(async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);
    });

    test('updates socketId on SOCKET_ID_UPDATE', () => {
      h.mockChannel.onmessage(msg(socketProxy, { type: 'SOCKET_ID_UPDATE', data: { id: 'new-id' } }));
      expect(socketProxy.id).toBe('new-id');
    });

    test('clears socketId when the sentinel arrives', () => {
      h.mockChannel.onmessage(msg(socketProxy, { type: 'SOCKET_ID_UPDATE', data: { id: 'new-id' } }));
      h.mockChannel.onmessage(msg(socketProxy, { type: 'SOCKET_ID_UPDATE', data: { id: '' } }));
      expect(socketProxy.id).toBeUndefined();
    });

    test('ignores a message type that is not part of the protocol', () => {
      // GET_SOCKET_ID / SOCKET_ID_RESPONSE were a request/response pair that
      // nothing ever sent; they are gone, and must now be rejected outright.
      (socketProxy as any).socketId = 'unchanged';
      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'SOCKET_ID_RESPONSE', data: { id: 'answered-id' },
      }));
      expect(socketProxy.id).toBe('unchanged');
    });

    test('updates active status on ACTIVE_STATUS_UPDATE', () => {
      h.mockChannel.onmessage(msg(socketProxy, { type: 'ACTIVE_STATUS_UPDATE', data: { active: true } }));
      expect(socketProxy.active).toBe(true);

      h.mockChannel.onmessage(msg(socketProxy, { type: 'ACTIVE_STATUS_UPDATE', data: { active: false } }));
      expect(socketProxy.active).toBe(false);
    });
  });

  describe('message validation', () => {
    beforeEach(async () => {
      await electAsPrimary(socketProxy);
    });

    function bad(payload: any) {
      h.mockChannel.onmessage({ data: { ...payload, token: getToken(socketProxy) } });
    }

    test('rejects an unknown message type', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      bad({ type: 'INVALID_TYPE', data: { event: 'test-event', args: ['x'] } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('rejects a missing message type', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      bad({ data: { event: 'test-event', args: ['x'] } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('rejects null and non-object payloads', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      h.mockChannel.onmessage({ data: null });
      h.mockChannel.onmessage({ data: 'not-an-object' });
      expect(callback).not.toHaveBeenCalled();
    });

    test('rejects EMIT with a missing event field', () => {
      bad({ type: 'EMIT', data: { args: ['x'] } });
      expect(h.mockSocket.emit).not.toHaveBeenCalled();
    });

    test('rejects EMIT with a missing args field', () => {
      bad({ type: 'EMIT', data: { event: 'test' } });
      expect(h.mockSocket.emit).not.toHaveBeenCalled();
    });

    test('rejects EMIT with non-array args', () => {
      bad({ type: 'EMIT', data: { event: 'test', args: 'not-array' } });
      expect(h.mockSocket.emit).not.toHaveBeenCalled();
    });

    test('rejects EVENT with a missing event field', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      bad({ type: 'EVENT', data: { args: ['x'] } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('rejects EVENT with non-array args', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      bad({ type: 'EVENT', data: { event: 'test-event', args: 'not-array' } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('rejects CONNECTION_STATUS with a non-boolean connected', () => {
      bad({ type: 'CONNECTION_STATUS', data: { connected: 'yes' } });
      expect(socketProxy.connected).toBeFalsy();
    });

    test('rejects EMIT_WITH_ACK with a missing id', () => {
      bad({ type: 'EMIT_WITH_ACK', data: { event: 'test', args: [] } });
      expect(h.mockSocket.emitWithAck).not.toHaveBeenCalled();
    });

    test('rejects MESSAGE_TO_PRIMARY with a missing eventName', () => {
      const subscriber = jest.fn();
      socketProxy.onProxyMessage('chat', subscriber);
      bad({ type: 'MESSAGE_TO_PRIMARY', data: { message: 'hi' } });
      expect(subscriber).not.toHaveBeenCalled();
    });

    test('rejects SOCKET_ID_UPDATE with a non-string id', () => {
      (socketProxy as any).socketId = 'unchanged';
      (socketProxy as any).isPrimary = false;
      bad({ type: 'SOCKET_ID_UPDATE', data: { id: 42 } });
      expect(socketProxy.id).toBe('unchanged');
    });

    test('rejects HEARTBEAT and PRIMARY_CLAIM with no tabId', () => {
      expect(() => bad({ type: 'HEARTBEAT' })).not.toThrow();
      bad({ type: 'PRIMARY_CLAIM', data: {} });
      expect(socketProxy.isPrimary).toBe(true);
    });

    test('rejects PRIMARY_ALIVE missing its state fields', async () => {
      const fresh = new SocketIOProxy('partial-channel', 'ws://test-url');
      h.mockChannel.postMessage.mockImplementation((posted: any) => {
        if (posted.type === 'PRIMARY_CHECK' && h.mockChannel.onmessage) {
          h.mockChannel.onmessage({
            data: { type: 'PRIMARY_ALIVE', token: getToken(fresh), data: { tabId: 'ab' } },
          });
        }
      });

      const promise = fresh.initialize();
      jest.advanceTimersByTime(2000);
      await promise;

      // The malformed answer is discarded, so the tab still promotes itself.
      expect(fresh.isPrimary).toBe(true);
    });

    test('accepts DISCONNECT and CONNECT with no data', () => {
      h.mockChannel.onmessage(msg(socketProxy, { type: 'DISCONNECT' }));
      h.mockChannel.onmessage(msg(socketProxy, { type: 'CONNECT' }));
      expect(h.mockSocket.disconnect).toHaveBeenCalled();
      expect(h.mockSocket.connect).toHaveBeenCalled();
    });

    test('does not log rejections when debug is disabled (default)', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      h.mockChannel.onmessage({ data: { type: 'BOGUS' } });
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
