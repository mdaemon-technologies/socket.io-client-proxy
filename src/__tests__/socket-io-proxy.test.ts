import SocketIOProxy from '../socket-io-proxy';
import { io } from 'socket.io-client';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('socket.io-client');
jest.mock('@mdaemon/validate', () => {
  const createSchemaValidator = (_name: string, schema: any) => {
    return (input: any) => {
      const errors: string[] = [];
      if (schema.required && (input == null)) {
        return { valid: false, errors: ['Value is required'] };
      }
      if (schema.type === 'object' && schema.properties && input != null) {
        for (const [key, prop] of Object.entries(schema.properties) as any[]) {
          if (prop.required && (input[key] == null || input[key] === '')) {
            errors.push(`${key}: Value is required`);
          }
          if (prop.type === 'string' && input[key] != null && typeof input[key] !== 'string') {
            errors.push(`${key}: Expected string`);
          }
          if (prop.type === 'boolean' && input[key] != null && typeof input[key] !== 'boolean') {
            errors.push(`${key}: Expected boolean`);
          }
          if (prop.type === 'array' && input[key] != null && !Array.isArray(input[key])) {
            errors.push(`${key}: Expected array`);
          }
          if (prop.type === 'string' && prop.minLength && typeof input[key] === 'string' && input[key].length < prop.minLength) {
            errors.push(`${key}: Minimum length is ${prop.minLength}`);
          }
        }
      }
      return { valid: errors.length === 0, errors };
    };
  };

  return {
    __esModule: true,
    default: { createSchemaValidator },
    createSchemaValidator,
  };
});

describe('SocketProxy', () => {
  let socketProxy: SocketIOProxy;
  let mockSocket: any;
  let mockChannel: any;
  const TEST_TOKEN = 'aa'.repeat(24);

  // Helper to get the proxy's internal token
  function getToken(proxy: SocketIOProxy): string {
    return (proxy as any).token;
  }

  // Helper to create a message with the correct token
  function msg(proxy: SocketIOProxy, payload: any) {
    return { data: { ...payload, token: getToken(proxy) } };
  }

  beforeEach(() => {
    jest.useFakeTimers();

    // Mock crypto.getRandomValues for deterministic tokens
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: (arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i++) arr[i] = 0xaa;
          return arr;
        }
      },
      writable: true,
      configurable: true,
    });

    mockSocket = {
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
      io: {
        on: jest.fn()
      }
    };

    (io as jest.Mock).mockReturnValue(mockSocket);

    mockChannel = {
      postMessage: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      close: jest.fn(),
      onmessage: null as any
    };

    globalThis.BroadcastChannel = jest.fn().mockImplementation(() => mockChannel) as unknown as typeof BroadcastChannel;
    socketProxy = new SocketIOProxy('test-channel', 'ws://test-url');
  });

  afterEach(() => {
    jest.useRealTimers();
  });
  
  test('should initialize as secondary if primary exists', async () => {
    mockChannel.postMessage.mockImplementation((msg: any) => {
      if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
        mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
      }
    });

    await socketProxy.initialize();
    expect(socketProxy.isPrimary).toBeFalsy();
  });

  test('should become primary if no response received', async () => {
    const initPromise = socketProxy.initialize();
    jest.advanceTimersByTime(2000);
    await initPromise;
    expect(socketProxy.isPrimary).toBeTruthy();
  });

  test('should handle emitWithAck in primary mode', async () => {
    const initPromise = socketProxy.initialize();
    jest.advanceTimersByTime(2000);
    await initPromise;

    const response = { data: 'test' };
    mockSocket.emitWithAck.mockResolvedValue(response);

    const result = await socketProxy.emitWithAck('test-event', 'data');
    expect(result).toEqual(response);
  });

  test('should handle onProxyMessage subscription and unsubscription', () => {
    const subscriber = jest.fn();
    const unsubscribe = socketProxy.onProxyMessage('test-event', subscriber);
    
    socketProxy['publishMessage']('test-event', 'test-data');
    expect(subscriber).toHaveBeenCalledWith('test-data');

    unsubscribe();
    socketProxy['publishMessage']('test-event', 'new-data');
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  test('should handle connection status updates', async () => {
    const initPromise = socketProxy.initialize();
    jest.advanceTimersByTime(2000);
    await initPromise;

    mockChannel.onmessage(msg(socketProxy, { type: 'CONNECTION_STATUS', data: { connected: true } }));
    expect(socketProxy.connected).toBeTruthy();
    expect(socketProxy.disconnected).toBeFalsy();

    mockChannel.onmessage(msg(socketProxy, { type: 'CONNECTION_STATUS', data: { connected: false } }));
    expect(socketProxy.connected).toBeFalsy();
    expect(socketProxy.disconnected).toBeTruthy();
  });

  test('should handle volatile and timeout methods', async () => {
    const initPromise = socketProxy.initialize();
    jest.advanceTimersByTime(2000);
    await initPromise;

    // volatile() should return the proxy for chaining
    const volatileResult = socketProxy.volatile();
    expect(volatileResult).toBe(socketProxy);

    // timeout() should return the proxy for chaining
    const timeoutResult = socketProxy.timeout(1000);
    expect(timeoutResult).toBe(socketProxy);
  });

  test('volatile().emit() should use socket.volatile.emit', async () => {
    const initPromise = socketProxy.initialize();
    jest.advanceTimersByTime(2000);
    await initPromise;

    const volatileEmit = jest.fn();
    mockSocket.volatile = { emit: volatileEmit };

    socketProxy.volatile().emit('test-event', 'arg1');
    expect(volatileEmit).toHaveBeenCalledWith('test-event', 'arg1');
    // Regular emit should not have been called
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  test('timeout().emit() should use socket.timeout().emit', async () => {
    const initPromise = socketProxy.initialize();
    jest.advanceTimersByTime(2000);
    await initPromise;

    const timeoutEmit = jest.fn();
    mockSocket.timeout.mockReturnValue({ emit: timeoutEmit, volatile: { emit: jest.fn() } });

    socketProxy.timeout(5000).emit('test-event', 'arg1');
    expect(mockSocket.timeout).toHaveBeenCalledWith(5000);
    expect(timeoutEmit).toHaveBeenCalledWith('test-event', 'arg1');
  });

  test('volatile/timeout flags reset after emit', async () => {
    const initPromise = socketProxy.initialize();
    jest.advanceTimersByTime(2000);
    await initPromise;

    const volatileEmit = jest.fn();
    mockSocket.volatile = { emit: volatileEmit };

    socketProxy.volatile().emit('first', 'a');
    expect(volatileEmit).toHaveBeenCalled();

    // Next emit should go through regular socket.emit
    mockSocket.emit.mockClear();
    socketProxy.emit('second', 'b');
    expect(mockSocket.emit).toHaveBeenCalledWith('second', 'b');
  });

  test('should handle socket id retrieval as primary', async () => {
    const initPromise = socketProxy.initialize();
    jest.advanceTimersByTime(2000);
    await initPromise;

    expect(socketProxy.id).toBe('test-socket-id');
  });

  test('should handle socket id retrieval as secondary', () => {
    socketProxy['socketId'] = 'secondary-id';
    expect(socketProxy.id).toBe('secondary-id');
  });

  test('should close channel', () => {
    socketProxy.closeChannel();
    expect(mockChannel.close).toHaveBeenCalled();
  });

  describe('on/off/once (primary mode)', () => {
    beforeEach(async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;
    });

    test('should register listener on socket when primary', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      expect(mockSocket.on).toHaveBeenCalledWith('test-event', callback);
    });

    test('should remove listener from socket when primary', () => {
      const callback = jest.fn();
      socketProxy.off('test-event', callback);
      expect(mockSocket.off).toHaveBeenCalledWith('test-event', callback);
    });

    test('should register once listener on socket when primary', () => {
      const callback = jest.fn();
      socketProxy.once('test-event', callback);
      expect(mockSocket.once).toHaveBeenCalledWith('test-event', callback);
    });
  });

  describe('on/off/once (secondary mode)', () => {
    beforeEach(async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();
    });

    test('should store listener locally when secondary', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      expect(socketProxy['listeners']['test-event']).toContain(callback);
    });

    test('should remove specific listener when secondary', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      socketProxy.on('test-event', callback1);
      socketProxy.on('test-event', callback2);
      socketProxy.off('test-event', callback1);
      expect(socketProxy['listeners']['test-event']).not.toContain(callback1);
      expect(socketProxy['listeners']['test-event']).toContain(callback2);
    });

    test('should remove all listeners for event when no callback specified', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      socketProxy.off('test-event');
      expect(socketProxy['listeners']['test-event']).toBeUndefined();
    });

    test('should invoke once listener only once via EVENT broadcast', () => {
      const callback = jest.fn();
      socketProxy.once('test-event', callback);

      mockChannel.onmessage(msg(socketProxy, { type: 'EVENT', data: { event: 'test-event', args: ['payload'] } }));
      expect(callback).toHaveBeenCalledWith('payload');

      mockChannel.onmessage(msg(socketProxy, { type: 'EVENT', data: { event: 'test-event', args: ['second'] } }));
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test('should dispatch EVENT messages to registered listeners', () => {
      const callback = jest.fn();
      socketProxy.on('chat', callback);

      mockChannel.onmessage(msg(socketProxy, { type: 'EVENT', data: { event: 'chat', args: ['hello', 'world'] } }));
      expect(callback).toHaveBeenCalledWith('hello', 'world');
    });
  });

  describe('emit (primary vs secondary)', () => {
    test('should emit directly on socket when primary', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      socketProxy.emit('test-event', 'arg1', 'arg2');
      expect(mockSocket.emit).toHaveBeenCalledWith('test-event', 'arg1', 'arg2');
    });

    test('should post EMIT message on channel when secondary', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      mockChannel.postMessage.mockClear();
      socketProxy.emit('test-event', 'arg1');
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT',
          data: { event: 'test-event', args: ['arg1'] }
        })
      );
    });
  });

  describe('emitWithAck (secondary mode)', () => {
    test('should post EMIT_WITH_ACK and resolve on response', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      mockChannel.addEventListener.mockImplementation((_event: string, handler: any) => {
        setTimeout(() => {
          const postCalls = mockChannel.postMessage.mock.calls;
          const ackCall = postCalls.find((c: any) => c[0].type === 'EMIT_WITH_ACK');
          if (ackCall) {
            handler({ data: { type: 'EMIT_WITH_ACK_RESPONSE', data: { id: ackCall[0].data.id, response: 'ack-result' }, token: TEST_TOKEN } });
          }
        }, 0);
      });

      mockChannel.postMessage.mockClear();
      const resultPromise = socketProxy.emitWithAck('test-event', 'data');
      jest.advanceTimersByTime(1);
      const result = await resultPromise;
      expect(result).toBe('ack-result');
      expect(mockChannel.removeEventListener).toHaveBeenCalled();
    });

    test('should reject with timeout error when primary never responds', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      // addEventListener registers handler but no response is ever sent
      mockChannel.addEventListener.mockImplementation(() => {});

      mockChannel.postMessage.mockClear();
      const resultPromise = socketProxy.emitWithAck('test-event', 'data');

      // Advance past the default 10s timeout
      jest.advanceTimersByTime(10000);

      await expect(resultPromise).rejects.toThrow('emitWithAck timed out waiting for primary response');
    });

    test('should remove event listener after timeout', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      mockChannel.addEventListener.mockImplementation(() => {});

      mockChannel.postMessage.mockClear();
      mockChannel.removeEventListener.mockClear();
      const resultPromise = socketProxy.emitWithAck('test-event', 'data');

      jest.advanceTimersByTime(10000);

      await resultPromise.catch(() => {});
      expect(mockChannel.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });

    test('should respect custom ackTimeout option', async () => {
      const customProxy = new SocketIOProxy('test-channel', 'ws://test-url', { ackTimeout: 5000 });
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await customProxy.initialize();

      mockChannel.addEventListener.mockImplementation(() => {});

      mockChannel.postMessage.mockClear();
      const resultPromise = customProxy.emitWithAck('test-event', 'data');

      // Should not reject before custom timeout
      jest.advanceTimersByTime(4999);
      // Still pending — no rejection yet

      jest.advanceTimersByTime(1);
      await expect(resultPromise).rejects.toThrow('emitWithAck timed out waiting for primary response');
    });

    test('should not reject after successful response clears timeout', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      mockChannel.addEventListener.mockImplementation((_event: string, handler: any) => {
        // Respond after 50ms (well before the 10s timeout)
        setTimeout(() => {
          const postCalls = mockChannel.postMessage.mock.calls;
          const ackCall = postCalls.find((c: any) => c[0].type === 'EMIT_WITH_ACK');
          if (ackCall) {
            handler({ data: { type: 'EMIT_WITH_ACK_RESPONSE', data: { id: ackCall[0].data.id, response: 'ok' }, token: TEST_TOKEN } });
          }
        }, 50);
      });

      mockChannel.postMessage.mockClear();
      const resultPromise = socketProxy.emitWithAck('test-event', 'data');
      jest.advanceTimersByTime(50);
      const result = await resultPromise;
      expect(result).toBe('ok');

      // Advance past original timeout — should not throw
      jest.advanceTimersByTime(10000);
    });
  });

  describe('connect/disconnect', () => {
    test('should call socket.connect() when primary', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      socketProxy.disconnect();
      expect(mockSocket.disconnect).toHaveBeenCalled();

      socketProxy.connect();
      expect(mockSocket.connect).toHaveBeenCalled();
    });

    test('should post DISCONNECT/CONNECT messages when secondary', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      mockChannel.postMessage.mockClear();
      socketProxy.disconnect();
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'DISCONNECT' })
      );

      mockChannel.postMessage.mockClear();
      socketProxy.connect();
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CONNECT' })
      );
    });
  });

  describe('primary handles commands from secondary tabs', () => {
    beforeEach(async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;
    });

    test('should respond to PRIMARY_CHECK with PRIMARY_ALIVE', () => {
      mockChannel.postMessage.mockClear();
      // PRIMARY_CHECK is a handshake message - no token needed
      mockChannel.onmessage({ data: { type: 'PRIMARY_CHECK' } });
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIMARY_ALIVE' })
      );
    });

    test('should forward EMIT to socket', () => {
      mockChannel.onmessage(msg(socketProxy, { type: 'EMIT', data: { event: 'msg', args: ['hello'] } }));
      expect(mockSocket.emit).toHaveBeenCalledWith('msg', 'hello');
    });

    test('should forward EMIT_WITH_ACK to socket and broadcast response', async () => {
      const ackResponse = { ok: true };
      mockSocket.emitWithAck.mockResolvedValue(ackResponse);

      mockChannel.postMessage.mockClear();
      mockChannel.onmessage(msg(socketProxy, { type: 'EMIT_WITH_ACK', data: { event: 'req', args: ['x'], id: 'abc123' } }));

      await jest.advanceTimersByTimeAsync(0);

      expect(mockSocket.emitWithAck).toHaveBeenCalledWith('req', 'x');
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT_WITH_ACK_RESPONSE',
          data: { id: 'abc123', response: ackResponse }
        })
      );
    });

    test('should call socket.disconnect on DISCONNECT command', () => {
      mockChannel.onmessage(msg(socketProxy, { type: 'DISCONNECT' }));
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    test('should call socket.connect on CONNECT command', () => {
      mockChannel.onmessage(msg(socketProxy, { type: 'CONNECT' }));
      expect(mockSocket.connect).toHaveBeenCalled();
    });

    test('should respond to GET_SOCKET_ID with socket id', () => {
      mockChannel.postMessage.mockClear();
      mockChannel.onmessage(msg(socketProxy, { type: 'GET_SOCKET_ID' }));
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SOCKET_ID_RESPONSE',
          data: { id: 'test-socket-id' }
        })
      );
    });

    test('should publish message on MESSAGE_TO_PRIMARY', () => {
      const subscriber = jest.fn();
      socketProxy.onProxyMessage('chat', subscriber);

      mockChannel.onmessage(msg(socketProxy, { type: 'MESSAGE_TO_PRIMARY', data: { eventName: 'chat', message: 'hi' } }));
      expect(subscriber).toHaveBeenCalledWith('hi');
    });

    test('should call onPrimaryCheck callback on PRIMARY_CHECK', () => {
      const callback = jest.fn();
      socketProxy.onPrimaryCheck(callback);

      mockChannel.onmessage({ data: { type: 'PRIMARY_CHECK' } });
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('secondary handles broadcasts from primary', () => {
    beforeEach(async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();
    });

    test('should update socketId on SOCKET_ID_UPDATE', () => {
      mockChannel.onmessage(msg(socketProxy, { type: 'SOCKET_ID_UPDATE', data: { id: 'new-id' } }));
      expect(socketProxy.id).toBe('new-id');
    });

    test('should update active status on ACTIVE_STATUS_UPDATE', () => {
      mockChannel.onmessage(msg(socketProxy, { type: 'ACTIVE_STATUS_UPDATE', data: { active: true } }));
      expect(socketProxy.active).toBeTruthy();

      mockChannel.onmessage(msg(socketProxy, { type: 'ACTIVE_STATUS_UPDATE', data: { active: false } }));
      expect(socketProxy.active).toBeFalsy();
    });
  });

  describe('getters', () => {
    test('io getter returns socket.io when primary', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      expect(socketProxy.io).toBe(mockSocket.io);
    });

    test('io getter returns null when secondary', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      expect(socketProxy.io).toBeNull();
    });

    test('active getter returns socket.active when primary', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      expect(socketProxy.active).toBe(true);
    });

    test('active getter returns cached socketActive when secondary', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      expect(socketProxy.active).toBe(false);
      socketProxy['socketActive'] = true;
      expect(socketProxy.active).toBe(true);
    });
  });

  describe('sendMessageToPrimary', () => {
    test('should post MESSAGE_TO_PRIMARY on channel', () => {
      const message = { eventName: 'update', message: { foo: 'bar' } };
      socketProxy.sendMessageToPrimary(message);
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'MESSAGE_TO_PRIMARY',
          data: message
        })
      );
    });
  });

  describe('directChannelEmit', () => {
    test('should post EVENT message directly on channel', () => {
      socketProxy.directChannelEmit('custom-event', 'a', 'b');
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EVENT',
          data: { event: 'custom-event', args: ['a', 'b'] }
        })
      );
    });
  });

  describe('channelId validation', () => {
    test('should throw when empty string provided', () => {
      expect(() => new SocketIOProxy('', 'ws://test-url')).toThrow(
        'channelId is required and must be a non-empty string'
      );
    });
  });

  describe('message validation', () => {
    beforeEach(async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;
    });

    test('should reject messages with invalid type', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      mockChannel.onmessage({ data: { type: 'INVALID_TYPE', data: { event: 'test-event', args: ['x'] }, token: TEST_TOKEN } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('should reject messages with missing type', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      mockChannel.onmessage({ data: { data: { event: 'test-event', args: ['x'] }, token: TEST_TOKEN } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('should reject null message data', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      mockChannel.onmessage({ data: null });
      expect(callback).not.toHaveBeenCalled();
    });

    test('should reject non-object message data', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      mockChannel.onmessage({ data: 'not-an-object' });
      expect(callback).not.toHaveBeenCalled();
    });

    test('should reject EMIT with missing event field', () => {
      mockChannel.onmessage({ data: { type: 'EMIT', data: { args: ['x'] }, token: TEST_TOKEN } });
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    test('should reject EMIT with missing args field', () => {
      mockChannel.onmessage({ data: { type: 'EMIT', data: { event: 'test' }, token: TEST_TOKEN } });
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    test('should reject EMIT with non-array args', () => {
      mockChannel.onmessage({ data: { type: 'EMIT', data: { event: 'test', args: 'not-array' }, token: TEST_TOKEN } });
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    test('should reject EVENT with missing event field', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      mockChannel.onmessage({ data: { type: 'EVENT', data: { args: ['x'] }, token: TEST_TOKEN } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('should reject EVENT with non-array args', () => {
      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      mockChannel.onmessage({ data: { type: 'EVENT', data: { event: 'test-event', args: 'not-array' }, token: TEST_TOKEN } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('should reject CONNECTION_STATUS with non-boolean connected', () => {
      mockChannel.onmessage({ data: { type: 'CONNECTION_STATUS', data: { connected: 'yes' }, token: TEST_TOKEN } });
      expect(socketProxy.connected).toBeFalsy();
    });

    test('should reject EMIT_WITH_ACK with missing id', () => {
      mockChannel.onmessage({ data: { type: 'EMIT_WITH_ACK', data: { event: 'test', args: [] }, token: TEST_TOKEN } });
      expect(mockSocket.emitWithAck).not.toHaveBeenCalled();
    });

    test('should reject MESSAGE_TO_PRIMARY with missing eventName', () => {
      const subscriber = jest.fn();
      socketProxy.onProxyMessage('chat', subscriber);

      mockChannel.onmessage({ data: { type: 'MESSAGE_TO_PRIMARY', data: { message: 'hi' }, token: TEST_TOKEN } });
      expect(subscriber).not.toHaveBeenCalled();
    });

    test('should accept valid DISCONNECT with no data', () => {
      mockChannel.onmessage(msg(socketProxy, { type: 'DISCONNECT' }));
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    test('should accept valid CONNECT with no data', () => {
      mockChannel.onmessage(msg(socketProxy, { type: 'CONNECT' }));
      expect(mockSocket.connect).toHaveBeenCalled();
    });

    test('should log warning for rejected messages when debug enabled', () => {
      const debugProxy = new SocketIOProxy('debug-channel', 'ws://test-url', { debug: true });
      const debugInitPromise = debugProxy.initialize();
      jest.advanceTimersByTime(2000);
      return debugInitPromise.then(() => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        mockChannel.onmessage({ data: { type: 'BOGUS' } });
        expect(logSpy).toHaveBeenCalledWith(
          '[SocketIOProxy]',
          'BroadcastChannel message rejected:',
          expect.any(Array)
        );
        logSpy.mockRestore();
      });
    });

    test('should NOT log when debug is disabled (default)', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockChannel.onmessage({ data: { type: 'BOGUS' } });
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe('message token validation', () => {
    test('should include token in outgoing messages', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      mockChannel.postMessage.mockClear();
      socketProxy.emit('test', 'data');

      const call = mockChannel.postMessage.mock.calls[0][0];
      expect(call.token).toBeDefined();
      expect(typeof call.token).toBe('string');
      expect(call.token.length).toBeGreaterThan(0);
    });

    test('should reject messages with missing token', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      // Message without token
      mockChannel.onmessage({ data: { type: 'EVENT', data: { event: 'test-event', args: ['x'] } } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('should reject messages with wrong token', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      mockChannel.onmessage({ data: { type: 'EVENT', data: { event: 'test-event', args: ['x'] }, token: 'wrong-token' } });
      expect(callback).not.toHaveBeenCalled();
    });

    test('should accept messages with correct token', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      mockChannel.onmessage(msg(socketProxy, { type: 'EVENT', data: { event: 'test-event', args: ['payload'] } }));
      expect(callback).toHaveBeenCalledWith('payload');
    });

    test('should allow PRIMARY_CHECK without token validation', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      mockChannel.postMessage.mockClear();
      mockChannel.onmessage({ data: { type: 'PRIMARY_CHECK' } });
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIMARY_ALIVE' })
      );
    });

    test('should adopt token from PRIMARY_ALIVE during handshake', async () => {
      const secondaryChannel = {
        postMessage: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        close: jest.fn(),
        onmessage: null as any
      };
      globalThis.BroadcastChannel = jest.fn().mockImplementation(() => secondaryChannel) as unknown as typeof BroadcastChannel;
      const secondaryProxy = new SocketIOProxy('token-channel', 'ws://test-url');

      const primaryToken = 'primary-shared-token-abc123';
      secondaryChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && secondaryChannel.onmessage) {
          secondaryChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: primaryToken } });
        }
      });

      await secondaryProxy.initialize();
      expect(secondaryProxy.isPrimary).toBe(false);

      const callback = jest.fn();
      secondaryProxy.on('test-event', callback);

      // Message with primary's token should be accepted
      secondaryChannel.onmessage({ data: { type: 'EVENT', data: { event: 'test-event', args: ['hello'] }, token: primaryToken } });
      expect(callback).toHaveBeenCalledWith('hello');
    });
  });

  describe('heartbeat', () => {
    test('primary should broadcast HEARTBEAT at configured interval', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      mockChannel.postMessage.mockClear();
      jest.advanceTimersByTime(3000);
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'HEARTBEAT' })
      );
    });

    test('primary should broadcast HEARTBEAT with custom interval', async () => {
      const customProxy = new SocketIOProxy('hb-channel', 'ws://test-url', { heartbeatInterval: 1000 });
      const initPromise = customProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      mockChannel.postMessage.mockClear();
      jest.advanceTimersByTime(1000);
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'HEARTBEAT' })
      );
    });

    test('secondary should start heartbeat monitor after election', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      // The secondary should have a heartbeat monitor running
      expect(socketProxy['heartbeatMonitorTimer']).not.toBeNull();
    });

    test('secondary should trigger re-election when heartbeat lost', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();
      expect(socketProxy.isPrimary).toBe(false);

      // Now stop answering PRIMARY_CHECK (simulate primary crash)
      mockChannel.postMessage.mockImplementation(() => {});

      // Advance past heartbeatTimeout (default 10s) + one check interval (3s)
      jest.advanceTimersByTime(13000);

      // After re-election timeout (2000ms), should become primary
      jest.advanceTimersByTime(2000);
      expect(socketProxy.isPrimary).toBe(true);
    });

    test('HEARTBEAT message should update lastHeartbeat on secondary', async () => {
      mockChannel.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'PRIMARY_CHECK' && mockChannel.onmessage) {
          mockChannel.onmessage({ data: { type: 'PRIMARY_ALIVE', token: TEST_TOKEN } });
        }
      });
      await socketProxy.initialize();

      const before = socketProxy['lastHeartbeat'];
      jest.advanceTimersByTime(1000);
      mockChannel.onmessage(msg(socketProxy, { type: 'HEARTBEAT' }));
      expect(socketProxy['lastHeartbeat']).toBeGreaterThanOrEqual(before);
    });

    test('closeChannel should stop heartbeat timers', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      socketProxy.closeChannel();
      expect(socketProxy['heartbeatTimer']).toBeNull();
      expect(socketProxy['heartbeatMonitorTimer']).toBeNull();
    });
  });

  describe('duplicate primary detection', () => {
    test('primary should broadcast PRIMARY_CLAIM on becoming primary', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PRIMARY_CLAIM',
          data: expect.objectContaining({ tabId: expect.any(String) })
        })
      );
    });

    test('primary should yield to higher tabId on PRIMARY_CLAIM', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;
      expect(socketProxy.isPrimary).toBe(true);

      // Simulate a PRIMARY_CLAIM from a tab with a higher tabId
      const higherTabId = 'zz'.repeat(24);
      mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_CLAIM', data: { tabId: higherTabId } }));
      expect(socketProxy.isPrimary).toBe(false);
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    test('primary should send PRIMARY_YIELD to lower tabId on PRIMARY_CLAIM', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      // Override tabId to be high so we win
      socketProxy['tabId'] = 'zz'.repeat(24);
      mockChannel.postMessage.mockClear();

      const lowerTabId = '00'.repeat(24);
      mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_CLAIM', data: { tabId: lowerTabId } }));
      expect(socketProxy.isPrimary).toBe(true);
      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PRIMARY_YIELD' })
      );
    });

    test('primary should demote on PRIMARY_YIELD', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_YIELD' }));
      expect(socketProxy.isPrimary).toBe(false);
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });
  });

  describe('emitWithAck error handling', () => {
    test('primary handler should post error response when emitWithAck throws', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      mockSocket.emitWithAck.mockRejectedValue(new Error('socket error'));
      mockChannel.postMessage.mockClear();

      mockChannel.onmessage(msg(socketProxy, { type: 'EMIT_WITH_ACK', data: { event: 'fail', args: [], id: 'err-id' } }));
      await jest.advanceTimersByTimeAsync(0);

      expect(mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMIT_WITH_ACK_RESPONSE',
          data: expect.objectContaining({ id: 'err-id', error: expect.stringContaining('socket error') })
        })
      );
    });

    test('primary emitWithAck should reject directly on error', async () => {
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      mockSocket.emitWithAck.mockRejectedValue(new Error('direct error'));
      await expect(socketProxy.emitWithAck('fail', 'data')).rejects.toThrow('direct error');
    });
  });

  describe('debug option', () => {
    test('should not log when debug is false (default)', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const initPromise = socketProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;
      logSpy.mockRestore();
      // No log calls for becoming primary
      expect(logSpy).not.toHaveBeenCalled();
    });

    test('should log when debug is true', async () => {
      const debugProxy = new SocketIOProxy('debug-ch', 'ws://test-url', { debug: true });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const initPromise = debugProxy.initialize();
      jest.advanceTimersByTime(2000);
      await initPromise;

      expect(logSpy).toHaveBeenCalledWith('[SocketIOProxy]', expect.anything(), expect.anything());
      logSpy.mockRestore();
    });
  });
});
