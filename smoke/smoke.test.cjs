'use strict';
// The CommonJS entry, resolved through package.json's "exports" -> "require",
// with the real socket.io-client.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { exercise } = require('./exercise.cjs');

test('require() loads dist/socket-io-proxy.umd.cjs', async () => {
  assert.equal(
    require.resolve('@mdaemon/socket.io-client-proxy'),
    path.resolve(__dirname, '..', 'dist', 'socket-io-proxy.umd.cjs')
  );
  await exercise(require('@mdaemon/socket.io-client-proxy'));
});
