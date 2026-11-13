// The ES module entry, resolved through package.json's "exports" -> "import",
// with the real socket.io-client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import SocketIOProxy from '@mdaemon/socket.io-client-proxy';
import smoke from './exercise.cjs';

test('import loads dist/socket-io-proxy.mjs', async () => {
  // import.meta.resolve needs a flag before Node 18.19; the import above has
  // already resolved either way, so this only pins down which file it chose.
  if (typeof import.meta.resolve === 'function') {
    assert.equal(
      fileURLToPath(import.meta.resolve('@mdaemon/socket.io-client-proxy')),
      fileURLToPath(new URL('../dist/socket-io-proxy.mjs', import.meta.url))
    );
  }
  await smoke.exercise(SocketIOProxy);
});
