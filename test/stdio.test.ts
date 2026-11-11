import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { ProcessTransport } from '../src/stdio.js';

const script = `
process.stdout.write('a log line that is not JSON\\n');
process.stdout.write('{"json":"but not JSON-RPC"}\\n');
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ping' }) + '\\n');
process.stderr.write('x'.repeat(5000) + 'END');
process.stdin.on('end', () => process.exit(0)).resume();
`;

test('skips non-JSON lines, reports invalid messages, and keeps reading', async () => {
  const transport = new ProcessTransport({ command: process.execPath, args: ['-e', script], graceMs: 200 });
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  await transport.start();
  const deadline = Date.now() + 5000;
  while (messages.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await transport.shutdown();
  assert.deepEqual(messages, [{ jsonrpc: '2.0', method: 'notifications/ping' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? '', /unreadable output from server/);
  // Only the last 4 KB of stderr is kept.
  assert.equal(transport.stderrTail.length, 4096);
  assert.ok(transport.stderrTail.endsWith('END'));
});

test('shutdown is idempotent, and send after exit fails cleanly', async () => {
  const transport = new ProcessTransport({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], graceMs: 200 });
  await transport.start();
  await assert.rejects(transport.start(), /already started/);
  await Promise.all([transport.shutdown(), transport.close()]);
  await transport.exited;
  await assert.rejects(transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 }), /server is not running/);
});

test('reports output larger than the read buffer', async () => {
  // Writes 11 MB without a newline, past the SDK's default buffer limit.
  const big = 'process.stdout.write("x".repeat(11 * 1024 * 1024)); process.stdin.resume();';
  const transport = new ProcessTransport({ command: process.execPath, args: ['-e', big], graceMs: 200 });
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  await transport.start();
  const deadline = Date.now() + 5000;
  while (errors.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await transport.shutdown();
  assert.ok(errors.length > 0);
  assert.match(errors[0]?.message ?? '', /unreadable output from server: ReadBuffer exceeded/);
});
