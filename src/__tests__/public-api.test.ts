import SocketIOProxy from '../socket-io-proxy';
import type { ConnectionState, ProxyMessage, SocketIOProxyOptions } from '../socket-io-proxy';
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { installFakes, restoreFakes } from './helpers/harness';

vi.mock('socket.io-client');

/**
 * Pins the public surface, so moving code between modules cannot add, drop or
 * rename a member unnoticed. The member lists are checked against
 * `keyof SocketIOProxy` at compile time (`npm run typecheck`) and against a
 * live instance at run time.
 */

const METHODS = [
  'initialize',
  'forcePrimary',
  'connectionUpdate',
  'on',
  'once',
  'off',
  'emit',
  'emitWithAck',
  'onPrimaryCheck',
  'disconnect',
  'connect',
  'volatile',
  'peers',
  'timeout',
  'sendMessageToPrimary',
  'onProxyMessage',
  'directChannelEmit',
  'closeChannel',
] as const;

const PROPERTIES = [
  'isPrimary',
  'channelName',
  'connected',
  'disconnected',
  'wantsConnection',
  'io',
  'active',
  'id',
] as const;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// A compile error here means the public members changed.
const exactMembers: Equal<
  keyof SocketIOProxy,
  typeof METHODS[number] | typeof PROPERTIES[number]
> = true;

// The exported option and payload types keep their shape.
const options: Required<Pick<
  SocketIOProxyOptions,
  'debug' | 'heartbeatInterval' | 'heartbeatTimeout' | 'ackTimeout' | 'electionTimeout'
  | 'electionJitter' | 'isolateByAuth' | 'warnOnIdentityMismatch' | 'autoConnect'
>> = {
  debug: false,
  heartbeatInterval: 1,
  heartbeatTimeout: 1,
  ackTimeout: 1,
  electionTimeout: 1,
  electionJitter: 1,
  isolateByAuth: true,
  warnOnIdentityMismatch: true,
  autoConnect: true,
};
const state: ConnectionState = { connected: false, id: undefined, active: false, wantsConnection: true };
const message: ProxyMessage = { eventName: 'x', message: 1 };

describe('public API', () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(restoreFakes);

  test('the member lists match the class', () => {
    expect(exactMembers).toBe(true);
    expect([options, state, message]).toHaveLength(3);
  });

  test('every method is callable on an instance', () => {
    const proxy = new SocketIOProxy('api', 'ws://host') as any;
    METHODS.forEach((name) => expect(typeof proxy[name], name).toBe('function'));
  });

  test('every property is readable and not a function', () => {
    const proxy = new SocketIOProxy('api', 'ws://host') as any;
    PROPERTIES.forEach((name) => {
      expect(name in proxy, name).toBe(true);
      expect(typeof proxy[name], name).not.toBe('function');
    });
  });

  test('the statics keep their values', () => {
    expect(SocketIOProxy.PROTOCOL_VERSION).toBe(3);
    expect(SocketIOProxy.PROXY_ERROR_EVENT).toBe('proxy_error');
    expect(SocketIOProxy.CONNECTION_STATE_EVENT).toBe('connection_state_changed');
    expect(typeof SocketIOProxy.channelNameFor).toBe('function');
  });

  test('chainable flags return the instance', () => {
    const proxy = new SocketIOProxy('api', 'ws://host');
    expect(proxy.volatile()).toBe(proxy);
    expect(proxy.peers()).toBe(proxy);
    expect(proxy.timeout(5)).toBe(proxy);
  });
});
