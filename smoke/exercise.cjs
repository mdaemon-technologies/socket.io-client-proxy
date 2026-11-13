'use strict';
/**
 * Smoke checks for the built bundles, shared by the smoke.test.* files.
 *
 * The full suite runs under Vitest, which needs Node 22.12 or later, but the
 * package supports Node 18. These checks run on every supported Node version
 * with nothing but node:test, node:assert and the package's own runtime
 * dependencies, so they need no dev install and no TypeScript. They check that
 * each bundle loads and that two proxies really elect and talk over Node's
 * BroadcastChannel; the Vitest suite covers behaviour in depth.
 *
 * Plain JavaScript on purpose: keep it to syntax and APIs Node 18.0 has. Each
 * file is run with plain `node`, not `node --test`, which Node 18.0 lacks;
 * node:test still runs the tests and sets a failing exit code.
 */
const assert = require('node:assert/strict');

/** How long any single wait may take before the check fails instead of hanging. */
const WAIT_MS = 5000;

/** Small timings so an election settles quickly with real timers. */
const FAST = { autoConnect: false, electionTimeout: 50, electionJitter: 0, heartbeatInterval: 200 };

/**
 * Runs the checks against one loaded class.
 *
 * @param {Function} SocketIOProxy - The default export as a consumer receives it.
 * @param {object} [stub] - The `io` stub from makeStubIo(), when the bundle was
 *   given one instead of the real socket.io-client. Enables the checks that
 *   need to see or drive the primary's socket.
 */
async function exercise(SocketIOProxy, stub) {
  checkStatics(SocketIOProxy);
  checkChannelNames(SocketIOProxy);
  await checkElection(SocketIOProxy, stub);
}

/**
 * The class and its public statics.
 *
 * @param {Function} SocketIOProxy - The loaded class.
 */
function checkStatics(SocketIOProxy) {
  // Not checked by name: minification renames the class.
  assert.equal(typeof SocketIOProxy, 'function', 'the default export is the class');
  assert.equal(typeof SocketIOProxy.PROTOCOL_VERSION, 'number');
  assert.equal(typeof SocketIOProxy.PROXY_ERROR_EVENT, 'string');
  assert.equal(typeof SocketIOProxy.CONNECTION_STATE_EVENT, 'string');
  assert.equal(typeof SocketIOProxy.channelNameFor, 'function');
}

/**
 * Identity fingerprinting: same identity, same channel; different principal,
 * different channel.
 *
 * @param {Function} SocketIOProxy - The loaded class.
 */
function checkChannelNames(SocketIOProxy) {
  const url = 'https://example.com';
  const name = SocketIOProxy.channelNameFor('chat', url, { auth: { token: 'a', user: 'u' } });
  assert.match(name, /^chat#[0-9a-f]{16}$/);
  assert.equal(SocketIOProxy.channelNameFor('chat', url, { auth: { user: 'u', token: 'a' } }), name,
    'key order does not change the channel');
  assert.notEqual(SocketIOProxy.channelNameFor('chat', url, { auth: { token: 'b', user: 'u' } }), name,
    'a different principal gets a different channel');
  assert.equal(SocketIOProxy.channelNameFor('chat', url, { isolateByAuth: false }), 'chat');
  // Matched by message: the UMD bundle's Error comes from the vm context's realm.
  assert.throws(() => SocketIOProxy.channelNameFor('', url), { message: /channelId is required/ });
  assert.throws(() => SocketIOProxy.channelNameFor('chat', ''), { message: /url is required/ });
}

/**
 * Two proxies on one channel: one becomes primary, the other finds it and
 * settles as a secondary, and messages cross between them.
 *
 * @param {Function} SocketIOProxy - The loaded class.
 * @param {object} [stub] - The `io` stub, if the bundle was given one.
 */
async function checkElection(SocketIOProxy, stub) {
  const channelId = `smoke-${Math.random().toString(36).slice(2)}`;
  const url = 'http://127.0.0.1:1';
  const proxies = [];
  try {
    const primary = new SocketIOProxy(channelId, url, FAST);
    proxies.push(primary);
    await withTimeout(primary.initialize(), 'the first proxy to settle its election');
    assert.equal(primary.isPrimary, true, 'with nobody answering, the first proxy promotes itself');
    assert.equal(primary.connected, false, 'autoConnect: false leaves the socket closed');

    const secondary = new SocketIOProxy(channelId, url, FAST);
    proxies.push(secondary);
    await withTimeout(secondary.initialize(), 'the second proxy to settle its election');
    assert.equal(secondary.isPrimary, false, 'the second proxy finds the primary over BroadcastChannel');
    assert.equal(secondary.wantsConnection, false, 'the secondary adopts the channel\'s connection intent');
    assert.equal(secondary.channelName, primary.channelName);

    // Secondary -> primary over the channel, through the message validators.
    const direct = waitFor(callback => primary.on('smoke-direct', callback), 'a direct channel event');
    secondary.directChannelEmit('smoke-direct', { n: 1 }, 'two');
    assert.deepEqual(plain(await direct), [{ n: 1 }, 'two']);

    if (stub) {
      assert.equal(stub.sockets.length, 1, 'only the primary opened a socket');
      const socket = stub.sockets[0];

      // A secondary's emit is relayed to the primary's socket.
      const relayed = waitFor(callback => socket.onEmit(callback), 'the relayed emit');
      secondary.emit('smoke-emit', 42);
      assert.deepEqual(plain(await relayed), ['smoke-emit', 42]);

      // A server event on the primary's socket reaches the secondary's listeners.
      const forwarded = waitFor(callback => secondary.on('smoke-server', callback), 'the forwarded server event');
      socket.serverEvent('smoke-server', { ok: true });
      assert.deepEqual(plain(await forwarded), [{ ok: true }]);
    }
  }
  finally {
    // Leaves no timers or open channels behind, or the process never exits.
    proxies.forEach(proxy => proxy.closeChannel());
  }
}

/**
 * A stand-in for socket.io-client's `io`, as a page supplies it to the UMD
 * bundle. Records each socket it opens so the checks can see and drive the
 * primary's socket.
 *
 * @returns {{ io: Function, sockets: object[] }} The stub and its sockets.
 */
function makeStubIo() {
  const sockets = [];
  function io() {
    let anyHandler = null;
    const emitHandlers = [];
    const socket = {
      id: undefined,
      connected: false,
      active: false,
      volatile: null,
      io: { on() {}, off() {} },
      onAny(handler) { anyHandler = handler; },
      on() {},
      once() {},
      off() {},
      timeout() { return socket; },
      emit(...args) { emitHandlers.forEach(handler => handler(...args)); return socket; },
      emitWithAck() { return Promise.resolve(); },
      connect() { socket.connected = true; socket.active = true; return socket; },
      disconnect() { socket.connected = false; socket.active = false; return socket; },
      // Test hooks, not part of socket.io's API.
      onEmit(handler) { emitHandlers.push(handler); },
      serverEvent(event, ...args) { anyHandler(event, ...args); }
    };
    socket.volatile = socket;
    sockets.push(socket);
    return socket;
  }
  // The real global `io` carries itself as `io.io`, which the bundles import.
  io.io = io;
  return { io, sockets };
}

/**
 * Resolves with a callback's arguments the first time it is called.
 *
 * @param {(callback: Function) => void} register - Subscribes the callback.
 * @param {string} what - What is awaited, for the timeout message.
 * @returns {Promise<unknown[]>} The callback's arguments.
 */
function waitFor(register, what) {
  return withTimeout(new Promise(resolve => register((...args) => resolve(args))), what);
}

/**
 * Rejects if a promise does not settle in time, so a broken bundle fails the
 * check instead of hanging the job.
 *
 * @param {Promise<T>} promise - The promise to wait for.
 * @param {string} what - What is awaited, for the timeout message.
 * @returns {Promise<T>} The promise's result.
 * @template T
 */
function withTimeout(promise, what) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The class's own static members, for comparing bundles.
 *
 * @param {Function} SocketIOProxy - A loaded class.
 * @returns {string[]} The sorted static member names.
 */
function staticNames(SocketIOProxy) {
  return Object.getOwnPropertyNames(SocketIOProxy)
    .filter(key => !['length', 'name', 'prototype'].includes(key))
    .sort();
}

/**
 * Copies a value into this realm. The UMD bundle runs in a vm context, whose
 * objects have that context's prototypes, and strict deep equality compares
 * prototypes.
 *
 * @param {unknown} value - A JSON-compatible value.
 * @returns {unknown} An equal value built from this realm's objects.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { exercise, makeStubIo, staticNames, WAIT_MS };
