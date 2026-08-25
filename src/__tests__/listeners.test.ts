import SocketIOProxy from '../socket-io-proxy';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  Harness,
  installFakes,
  restoreFakes,
  listenersFor,
  electAsPrimary,
  joinAsSecondary,
  msg,
} from './helpers/harness';

jest.mock('socket.io-client');

const PROXY_ERROR_EVENT = SocketIOProxy.PROXY_ERROR_EVENT;

describe('listeners and inter-tab messaging', () => {
  let h: Harness;
  let socketProxy: SocketIOProxy;

  beforeEach(() => {
    h = installFakes();
    socketProxy = new SocketIOProxy('test-channel', 'ws://test-url');
  });

  afterEach(restoreFakes);

  function onAnyHandler(): (...args: any[]) => void {
    return h.mockSocket.onAny.mock.calls[0][0] as (...args: any[]) => void;
  }

  function sendEvent(event: string, ...args: any[]) {
    h.mockChannel.onmessage(msg(socketProxy, { type: 'EVENT', data: { event, args } }));
  }

  describe('on / off / once', () => {
    test('listeners are stored locally even when primary', async () => {
      await electAsPrimary(socketProxy);
      const callback = jest.fn();
      socketProxy.on('test-event', callback);

      expect(listenersFor(socketProxy, 'test-event')).toContain(callback);
      // Registering on the socket directly would lose the listener on demotion.
      expect(h.mockSocket.on).not.toHaveBeenCalledWith('test-event', callback);
    });

    test('primary dispatches socket events to local listeners via onAny', async () => {
      await electAsPrimary(socketProxy);
      const callback = jest.fn();
      socketProxy.on('chat', callback);

      onAnyHandler()('chat', 'hello');
      expect(callback).toHaveBeenCalledWith('hello');
    });

    test('stores listeners locally when secondary', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback = jest.fn();
      socketProxy.on('test-event', callback);
      expect(listenersFor(socketProxy, 'test-event')).toContain(callback);
    });

    test('removes a specific listener', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback1 = jest.fn();
      const callback2 = jest.fn();
      socketProxy.on('test-event', callback1);
      socketProxy.on('test-event', callback2);
      socketProxy.off('test-event', callback1);

      expect(listenersFor(socketProxy, 'test-event')).not.toContain(callback1);
      expect(listenersFor(socketProxy, 'test-event')).toContain(callback2);
    });

    test('off removes a callback registered while primary', async () => {
      await electAsPrimary(socketProxy);

      const callback = jest.fn();
      socketProxy.on('chat', callback);
      socketProxy.off('chat', callback);

      onAnyHandler()('chat', 'hello');
      expect(callback).not.toHaveBeenCalled();
    });

    test('off without a callback removes every listener for the event', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      socketProxy.on('test-event', jest.fn());
      socketProxy.off('test-event');
      expect(listenersFor(socketProxy, 'test-event')).toBeUndefined();
    });

    test('off is a no-op for an unknown event or callback', () => {
      expect(() => socketProxy.off('never-registered', jest.fn())).not.toThrow();
      expect(() => socketProxy.off('never-registered')).not.toThrow();
    });

    test('duplicate registrations of the same callback both fire', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback = jest.fn();
      socketProxy.on('dup', callback);
      socketProxy.on('dup', callback);

      sendEvent('dup');
      expect(callback).toHaveBeenCalledTimes(2);
    });

    test('once fires only once via EVENT broadcast', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback = jest.fn();
      socketProxy.once('test-event', callback);

      sendEvent('test-event', 'payload');
      expect(callback).toHaveBeenCalledWith('payload');

      sendEvent('test-event', 'second');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test('once fires only once for a primary too', async () => {
      await electAsPrimary(socketProxy);

      const callback = jest.fn();
      socketProxy.once('ping', callback);

      onAnyHandler()('ping', 1);
      onAnyHandler()('ping', 2);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(1);
    });

    test('dispatches EVENT messages to registered listeners', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback = jest.fn();
      socketProxy.on('chat', callback);

      sendEvent('chat', 'hello', 'world');
      expect(callback).toHaveBeenCalledWith('hello', 'world');
    });

    test('a listener unsubscribing mid-dispatch does not skip its peers', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const second = jest.fn();
      const first = jest.fn(() => socketProxy.off('burst', first));
      socketProxy.on('burst', first);
      socketProxy.on('burst', second);

      sendEvent('burst');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });
  });

  describe('prototype-chain event names', () => {
    const proto = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

    test.each(proto)('on("%s") registers and dispatches without throwing', async (name) => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback = jest.fn();
      expect(() => socketProxy.on(name, callback)).not.toThrow();

      sendEvent(name, 'x');
      expect(callback).toHaveBeenCalledWith('x');
    });

    test.each(proto)('an EVENT named "%s" with no listener is harmless', async (name) => {
      await joinAsSecondary(h.mockChannel, socketProxy);
      expect(() => sendEvent(name)).not.toThrow();
    });

    test('off works for prototype-chain names', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const callback = jest.fn();
      socketProxy.on('__proto__', callback);
      socketProxy.off('__proto__', callback);

      sendEvent('__proto__');
      expect(callback).not.toHaveBeenCalled();
    });

    test('onProxyMessage tolerates prototype-chain event names', () => {
      const subscriber = jest.fn();
      socketProxy.onProxyMessage('__proto__', subscriber);
      (socketProxy as any).publishMessage('__proto__', 'x');
      expect(subscriber).toHaveBeenCalledWith('x');
    });
  });

  describe('error containment', () => {
    beforeEach(async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);
    });

    test('a throwing listener does not break the message handler', () => {
      const good = jest.fn();
      socketProxy.on('boom', () => { throw new Error('listener blew up'); });
      socketProxy.on('boom', good);

      expect(() => sendEvent('boom')).not.toThrow();
      expect(good).toHaveBeenCalled();
    });

    test('listener failures surface on the proxy_error event', () => {
      const onError = jest.fn();
      socketProxy.on(PROXY_ERROR_EVENT, onError);
      socketProxy.on('boom', () => { throw new Error('listener blew up'); });

      sendEvent('boom');

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'listener blew up' }),
        expect.stringContaining('boom')
      );
    });

    test('a throwing proxy_error listener does not recurse', () => {
      socketProxy.on(PROXY_ERROR_EVENT, () => { throw new Error('handler blew up'); });
      socketProxy.on('boom', () => { throw new Error('listener blew up'); });

      expect(() => sendEvent('boom')).not.toThrow();
    });
  });

  describe('onProxyMessage / publishMessage', () => {
    test('subscribes and unsubscribes', () => {
      const subscriber = jest.fn();
      const unsubscribe = socketProxy.onProxyMessage('test-event', subscriber);

      (socketProxy as any).publishMessage('test-event', 'test-data');
      expect(subscriber).toHaveBeenCalledWith('test-data');

      unsubscribe();
      (socketProxy as any).publishMessage('test-event', 'new-data');
      expect(subscriber).toHaveBeenCalledTimes(1);
    });

    test('unsubscribing twice is harmless', () => {
      const unsubscribe = socketProxy.onProxyMessage('topic', jest.fn());
      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
    });

    test('a throwing subscriber does not stop the others', async () => {
      await electAsPrimary(socketProxy);

      const good = jest.fn();
      socketProxy.onProxyMessage('topic', () => { throw new Error('subscriber blew up'); });
      socketProxy.onProxyMessage('topic', good);

      expect(() =>
        h.mockChannel.onmessage(msg(socketProxy, {
          type: 'MESSAGE_TO_PRIMARY', data: { eventName: 'topic', message: 1 },
        }))
      ).not.toThrow();
      expect(good).toHaveBeenCalledWith(1);
    });
  });

  describe('sendMessageToPrimary', () => {
    test('posts MESSAGE_TO_PRIMARY on the channel when secondary', async () => {
      await joinAsSecondary(h.mockChannel, socketProxy);

      const message = { eventName: 'update', message: { foo: 'bar' } };
      socketProxy.sendMessageToPrimary(message);
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'MESSAGE_TO_PRIMARY', data: message })
      );
    });

    test('delivers locally when called on the primary', async () => {
      await electAsPrimary(socketProxy);

      const subscriber = jest.fn();
      socketProxy.onProxyMessage('sync', subscriber);
      h.mockChannel.postMessage.mockClear();

      socketProxy.sendMessageToPrimary({ eventName: 'sync', message: 42 });

      // BroadcastChannel never echoes to the sender, so the primary must
      // short-circuit rather than post into the void.
      expect(subscriber).toHaveBeenCalledWith(42);
      expect(h.mockChannel.postMessage).not.toHaveBeenCalled();
    });

    test('throws when eventName is missing', () => {
      expect(() => socketProxy.sendMessageToPrimary({ message: 'x' } as any))
        .toThrow("requires an object with a non-empty 'eventName'");
      expect(() => socketProxy.sendMessageToPrimary(undefined as any))
        .toThrow("requires an object with a non-empty 'eventName'");
    });
  });

  describe('onPrimaryCheck', () => {
    beforeEach(async () => {
      await electAsPrimary(socketProxy);
    });

    test('notifies on PRIMARY_CHECK', () => {
      const callback = jest.fn();
      socketProxy.onPrimaryCheck(callback);

      h.mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_CHECK' }));
      expect(callback).toHaveBeenCalled();
    });

    test('supports multiple subscribers', () => {
      const first = jest.fn();
      const second = jest.fn();
      socketProxy.onPrimaryCheck(first);
      socketProxy.onPrimaryCheck(second);

      h.mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_CHECK' }));
      expect(first).toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
    });

    test('returns an unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = socketProxy.onPrimaryCheck(callback);
      unsubscribe();

      h.mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_CHECK' }));
      expect(callback).not.toHaveBeenCalled();
    });

    test('a throwing subscriber does not stop the others', () => {
      const good = jest.fn();
      socketProxy.onPrimaryCheck(() => { throw new Error('bad subscriber'); });
      socketProxy.onPrimaryCheck(good);

      expect(() => h.mockChannel.onmessage(msg(socketProxy, { type: 'PRIMARY_CHECK' }))).not.toThrow();
      expect(good).toHaveBeenCalled();
    });
  });

  describe('directChannelEmit', () => {
    test('posts an EVENT message directly on the channel', () => {
      socketProxy.directChannelEmit('custom-event', 'a', 'b');
      expect(h.mockChannel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'EVENT', data: { event: 'custom-event', args: ['a', 'b'] } })
      );
    });

    test('also dispatches to the calling tab own listeners', () => {
      const callback = jest.fn();
      socketProxy.on('custom-event', callback);
      socketProxy.directChannelEmit('custom-event', 'payload');
      expect(callback).toHaveBeenCalledWith('payload');
    });
  });
});
