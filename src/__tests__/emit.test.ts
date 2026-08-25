import SocketIOProxy from '../socket-io-proxy';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  Harness,
  installFakes,
  restoreFakes,
  electAsPrimary,
  joinAsSecondary,
  msg,
} from './helpers/harness';

jest.mock('socket.io-client');

describe('emit and emitWithAck', () => {
  let h: Harness;
  let socketProxy: SocketIOProxy;

  beforeEach(() => {
    h = installFakes();
    socketProxy = new SocketIOProxy('test-channel', 'ws://test-url');
  });

  afterEach(restoreFakes);

  describe('emit', () => {
    test('emits directly on the socket when primary', async () => {
      await electAsPrimary(socketProxy);

      socketProxy.emit('test-event', 'arg1', 'arg2');
      expect(h.mockSocket.emit).toHaveBeenCalledWith('test-event', 'arg1', 'arg2');
    });

    test('posts an EMIT message when secondary', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      socketProxy.emit('test-event', 'arg1');
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'EMIT', data: { event: 'test-event', args: ['arg1'] } })
      );
    });

    test('omits unset flags so the payload validates', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      socketProxy.emit('plain');
      const posted = h.mockChannel.postMessage.mock.calls[0][0] as any;
      expect(Object.keys(posted.data).sort()).toEqual(['args', 'event']);
    });

    test('forwards volatile and timeout flags', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      socketProxy.volatile().timeout(1234).emit('flagged', 'x');
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT',
          data: { event: 'flagged', args: ['x'], volatile: true, timeout: 1234 },
        })
      );
    });
  });

  describe('volatile and timeout', () => {
    beforeEach(async () => {
      await electAsPrimary(socketProxy);
    });

    test('both are chainable', () => {
      expect(socketProxy.volatile()).toBe(socketProxy);
      expect(socketProxy.timeout(1000)).toBe(socketProxy);
    });

    test('volatile().emit() uses socket.volatile.emit', () => {
      const volatileEmit = jest.fn();
      h.mockSocket.volatile = { emit: volatileEmit };

      socketProxy.volatile().emit('test-event', 'arg1');
      expect(volatileEmit).toHaveBeenCalledWith('test-event', 'arg1');
      expect(h.mockSocket.emit).not.toHaveBeenCalled();
    });

    test('timeout().emit() uses socket.timeout().emit', () => {
      const timeoutEmit = jest.fn();
      h.mockSocket.timeout.mockReturnValue({ emit: timeoutEmit, volatile: { emit: jest.fn() } });

      socketProxy.timeout(5000).emit('test-event', 'arg1');
      expect(h.mockSocket.timeout).toHaveBeenCalledWith(5000);
      expect(timeoutEmit).toHaveBeenCalledWith('test-event', 'arg1');
    });

    test('flags reset after an emit', () => {
      const volatileEmit = jest.fn();
      h.mockSocket.volatile = { emit: volatileEmit };

      socketProxy.volatile().emit('first', 'a');
      expect(volatileEmit).toHaveBeenCalled();

      h.mockSocket.emit.mockClear();
      socketProxy.emit('second', 'b');
      expect(h.mockSocket.emit).toHaveBeenCalledWith('second', 'b');
    });

    test('flags reset even when emit throws on a reserved name', () => {
      expect(() => socketProxy.timeout(500).emit('connect')).toThrow('reserved event name');

      // The pending timeout must not leak into the next emission.
      socketProxy.emit('safe', 'x');
      expect(h.mockSocket.timeout).not.toHaveBeenCalled();
      expect(h.mockSocket.emit).toHaveBeenCalledWith('safe', 'x');
    });
  });

  describe('reserved event names', () => {
    test.each(['connect', 'disconnect', 'connect_error', 'disconnecting', 'newListener', 'removeListener'])(
      'emit("%s") throws locally instead of on the primary',
      async (name) => {
        await joinAsSecondary(h.mockChannel, socketProxy);

        expect(() => socketProxy.emit(name, 'x')).toThrow(`"${name}" is a reserved event name`);
        expect(h.mockChannel.postMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'EMIT' })
        );
      }
    );

    test('emitWithAck rejects on a reserved event name', async () => {
      await electAsPrimary(socketProxy);
      await expect(socketProxy.emitWithAck('connect')).rejects.toThrow('reserved event name');
      expect(h.mockSocket.emitWithAck).not.toHaveBeenCalled();
    });

    test('the primary ignores an EMIT carrying a reserved name', async () => {
      await electAsPrimary(socketProxy);

      expect(() =>
        h.mockChannel.onmessage(msg(socketProxy, { type: 'EMIT', data: { event: 'connect', args: [] } }))
      ).not.toThrow();
      expect(h.mockSocket.emit).not.toHaveBeenCalled();
    });

    test('the primary answers an EMIT_WITH_ACK for a reserved name with an error', async () => {
      await electAsPrimary(socketProxy);
      h.mockChannel.postMessage.mockClear();

      h.mockChannel.onmessage(msg(socketProxy, {
        type: 'EMIT_WITH_ACK',
        data: { event: 'disconnect', args: [], id: 'r1' },
      }));

      expect(h.mockSocket.emitWithAck).not.toHaveBeenCalled();
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT_WITH_ACK_RESPONSE',
          data: expect.objectContaining({ id: 'r1', error: expect.stringContaining('reserved') }),
        })
      );
    });
  });

  describe('emitWithAck as primary', () => {
    beforeEach(async () => {
      await electAsPrimary(socketProxy);
    });

    test('applies a pending timeout flag, as socket.io does', async () => {
      const emitWithAck = jest.fn<any>().mockResolvedValue('ok');
      h.mockSocket.timeout.mockReturnValue({ emitWithAck });

      await expect(socketProxy.timeout(500).emitWithAck('slow')).resolves.toBe('ok');
      expect(h.mockSocket.timeout).toHaveBeenCalledWith(500);
      expect(emitWithAck).toHaveBeenCalledWith('slow');
    });

    test('applies a pending volatile flag', async () => {
      const emitWithAck = jest.fn<any>().mockResolvedValue('ok');
      h.mockSocket.volatile = { emitWithAck };

      await expect(socketProxy.volatile().emitWithAck('maybe')).resolves.toBe('ok');
      expect(emitWithAck).toHaveBeenCalledWith('maybe');
    });

    test('consumes the flags so they do not leak into the next emit', async () => {
      const emitWithAck = jest.fn<any>().mockResolvedValue('ok');
      h.mockSocket.timeout.mockReturnValue({ emitWithAck });
      await socketProxy.timeout(500).emitWithAck('first');

      h.mockSocket.timeout.mockClear();
      socketProxy.emit('second', 'x');
      expect(h.mockSocket.timeout).not.toHaveBeenCalled();
      expect(h.mockSocket.emit).toHaveBeenCalledWith('second', 'x');
    });

    test('consumes the flags even when the event name is rejected', async () => {
      await expect(socketProxy.timeout(500).emitWithAck('connect')).rejects.toThrow('reserved');

      socketProxy.emit('safe');
      expect(h.mockSocket.timeout).not.toHaveBeenCalled();
      expect(h.mockSocket.emit).toHaveBeenCalledWith('safe');
    });

    test('resolves with the socket response', async () => {
      const response = { data: 'test' };
      h.mockSocket.emitWithAck.mockResolvedValue(response);

      await expect(socketProxy.emitWithAck('test-event', 'data')).resolves.toEqual(response);
    });

    test('rejects directly on error', async () => {
      h.mockSocket.emitWithAck.mockRejectedValue(new Error('direct error'));
      await expect(socketProxy.emitWithAck('fail', 'data')).rejects.toThrow('direct error');
    });
  });

  describe('emitWithAck as secondary', () => {
    beforeEach(async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);
    });

    function lastAckId(): string {
      const call = h.mockChannel.postMessage.mock.calls
        .map((c: any[]) => c[0])
        .reverse()
        .find((m: any) => m.type === 'EMIT_WITH_ACK');
      return call.data.id;
    }

    function respond(data: any) {
      h.mockChannel.onmessage(msg(socketProxy, { type: 'EMIT_WITH_ACK_RESPONSE', data }));
    }

    test('forwards pending timeout and volatile flags to the primary', () => {
      socketProxy.volatile().timeout(750).emitWithAck('flagged', 'x').catch(() => {});

      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT_WITH_ACK',
          data: expect.objectContaining({ event: 'flagged', volatile: true, timeout: 750 }),
        })
      );
    });

    test('omits unset flags so the payload validates', () => {
      socketProxy.emitWithAck('plain').catch(() => {});

      const posted = h.mockChannel.postMessage.mock.calls[0][0] as any;
      expect(Object.keys(posted.data).sort()).toEqual(['args', 'event', 'id']);
    });

    test('a post that cannot be cloned rejects without leaking a timer', async () => {
      const cloneError = new Error('could not be cloned');
      h.mockChannel.postMessage.mockImplementation(() => { throw cloneError; });

      await expect(socketProxy.emitWithAck('bad', () => {})).rejects.toThrow('could not be cloned');
      expect((socketProxy as any).pendingAcks.size).toBe(0);

      // A leaked timer would fire here and reject an already-settled promise.
      expect(() => jest.advanceTimersByTime(20000)).not.toThrow();
    });

    test('posts EMIT_WITH_ACK and resolves on response', async () => {
      const resultPromise = socketProxy.emitWithAck('test-event', 'data');
      respond({ id: lastAckId(), response: 'ack-result' });
      await expect(resultPromise).resolves.toBe('ack-result');
    });

    test('rejects when the primary reports an error', async () => {
      // Previously the error field was ignored and the promise resolved with
      // undefined, so callers could not tell success from failure.
      const resultPromise = socketProxy.emitWithAck('test-event', 'data');
      respond({ id: lastAckId(), error: 'operation has timed out' });
      await expect(resultPromise).rejects.toThrow('operation has timed out');
    });

    test('an undefined ack response still resolves', async () => {
      const resultPromise = socketProxy.emitWithAck('test-event');
      respond({ id: lastAckId() });
      await expect(resultPromise).resolves.toBeUndefined();
    });

    test('a response for an unknown id is ignored', () => {
      expect(() => respond({ id: 'nobody-is-waiting', response: 1 })).not.toThrow();
    });

    test('concurrent acks resolve independently', async () => {
      const first = socketProxy.emitWithAck('a');
      const firstId = lastAckId();
      const second = socketProxy.emitWithAck('b');
      const secondId = lastAckId();

      expect(firstId).not.toBe(secondId);

      respond({ id: secondId, response: 'B' });
      respond({ id: firstId, response: 'A' });

      await expect(first).resolves.toBe('A');
      await expect(second).resolves.toBe('B');
    });

    test('rejects with a timeout error when the primary never responds', async () => {
      const resultPromise = socketProxy.emitWithAck('test-event', 'data');
      jest.advanceTimersByTime(10000);
      await expect(resultPromise).rejects.toThrow('emitWithAck timed out waiting for primary response');
    });

    test('respects a custom ackTimeout', async () => {
      const customProxy = new SocketIOProxy('ack-channel', 'ws://test-url', { ackTimeout: 5000 });
      await joinAsSecondary(h.mockChannel, customProxy);

      const resultPromise = customProxy.emitWithAck('test-event', 'data');
      jest.advanceTimersByTime(4999);
      jest.advanceTimersByTime(1);

      await expect(resultPromise).rejects.toThrow('emitWithAck timed out waiting for primary response');
    });

    test('does not reject after a successful response clears the timeout', async () => {
      const resultPromise = socketProxy.emitWithAck('test-event', 'data');
      respond({ id: lastAckId(), response: 'ok' });
      await expect(resultPromise).resolves.toBe('ok');

      jest.advanceTimersByTime(10000);
    });

    test('a late response after timeout is ignored', async () => {
      const resultPromise = socketProxy.emitWithAck('test-event');
      const id = lastAckId();

      jest.advanceTimersByTime(10000);
      await expect(resultPromise).rejects.toThrow('timed out');

      expect(() => respond({ id, response: 'late' })).not.toThrow();
    });
  });
});
