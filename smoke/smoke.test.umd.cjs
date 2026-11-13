'use strict';
// The UMD bundle, as a <script> tag loads it: window.SocketIOProxy, with
// socket.io-client's global `io` supplied by the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { exercise, makeStubIo, staticNames } = require('./exercise.cjs');

const FILE = path.resolve(__dirname, '..', 'dist', 'socket-io-proxy.umd.js');

/**
 * Runs the UMD bundle as a classic script in a fresh context. The package is
 * "type": "module", so Node would load a .js file as ESM; a browser runs it as
 * a script, so this does too.
 *
 * @param {object} extra - Globals for the context beyond the browser basics.
 * @returns {object} The context's global object.
 */
function runBundle(extra) {
  // The browser globals the proxy uses. Node has them; the context does not.
  const context = Object.assign({
    BroadcastChannel,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console
  }, extra);
  // Node 18 has no global `crypto` unless a flag enables it; the proxy then
  // falls back to Math.random for its tab ids. Pass it on when there is one.
  if (typeof globalThis.crypto !== 'undefined') {
    context.crypto = globalThis.crypto;
  }
  vm.runInNewContext(fs.readFileSync(FILE, 'utf8'), context, { filename: FILE });
  return context;
}

test('dist/socket-io-proxy.umd.js defines window.SocketIOProxy', async () => {
  const stub = makeStubIo();
  const window = runBundle({ io: stub.io });
  await exercise(window.SocketIOProxy, stub);
});

test('dist/socket-io-proxy.umd.js fills module.exports under a CommonJS loader', async () => {
  // The bundle's CommonJS branch, which bundlers such as webpack 4 use.
  const stub = makeStubIo();
  const module = { exports: {} };
  const required = [];
  runBundle({
    module,
    exports: module.exports,
    require(id) {
      required.push(id);
      return stub;
    }
  });
  assert.deepEqual(required, ['socket.io-client']);
  await exercise(module.exports, stub);
});

test('the CommonJS, ES module and UMD bundles expose the same statics', async () => {
  const window = runBundle({ io: makeStubIo().io });
  const esm = (await import('@mdaemon/socket.io-client-proxy')).default;
  const cjs = require('@mdaemon/socket.io-client-proxy');

  assert.deepEqual(staticNames(esm), staticNames(cjs));
  assert.deepEqual(staticNames(window.SocketIOProxy), staticNames(cjs));
  for (const name of staticNames(cjs).filter(key => typeof cjs[key] !== 'function')) {
    assert.equal(esm[name], cjs[name], `ESM ${name}`);
    assert.equal(window.SocketIOProxy[name], cjs[name], `UMD ${name}`);
  }
});
