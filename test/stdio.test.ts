import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { DEFAULT_MAX_MESSAGE_BYTES, ProcessTransport } from '../src/stdio.js';

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

test('a server that writes without a newline is stopped at the cap', async () => {
  // Writes forever and never ends a line. Without a cap this grew to 771 MB in 8 s.
  const flood = 'const chunk = "x".repeat(65536); const write = () => { while (process.stdout.write(chunk)); }; process.stdout.on("drain", write); write(); process.stdin.resume();';
  const transport = new ProcessTransport({ command: process.execPath, args: ['-e', flood], graceMs: 2000, maxMessageBytes: 1024 * 1024 });
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  const started = Date.now();
  await transport.start();
  // No shutdown() call: the transport stops the server itself.
  await transport.exited;
  const elapsed = Date.now() - started;
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? '', /server wrote more than 1 MB without ending a message; stopping it/);
  assert.equal(transport.fatalError, errors[0]);
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
});

test('a message bigger than the SDK default buffer is still read', async () => {
  // 11 MB on one line: above the SDK ReadBuffer's 10 MB default, below the 64 MB cap.
  const big = 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "big", params: { x: "x".repeat(11 * 1024 * 1024) } }) + "\\n"); process.stdin.resume();';
  const transport = new ProcessTransport({ command: process.execPath, args: ['-e', big], graceMs: 200 });
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  await transport.start();
  const deadline = Date.now() + 10_000;
  while (messages.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await transport.shutdown();
  assert.deepEqual(errors, []);
  assert.equal(messages.length, 1);
  assert.equal(DEFAULT_MAX_MESSAGE_BYTES, 64 * 1024 * 1024);
});

test('lines split across chunks, CRLF endings and several messages per chunk are all read', async () => {
  const script = `
const a = JSON.stringify({ jsonrpc: '2.0', method: 'one' });
const b = JSON.stringify({ jsonrpc: '2.0', method: 'two' });
process.stdout.write(a.slice(0, 5));
setTimeout(() => process.stdout.write(a.slice(5) + '\\r\\n' + b + '\\n' + 'not json\\n'), 50);
process.stdin.resume();
`;
  const transport = new ProcessTransport({ command: process.execPath, args: ['-e', script], graceMs: 200 });
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (message) => messages.push(message);
  await transport.start();
  const deadline = Date.now() + 5000;
  while (messages.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await transport.shutdown();
  assert.deepEqual(messages, [
    { jsonrpc: '2.0', method: 'one' },
    { jsonrpc: '2.0', method: 'two' },
  ]);
});

test('shutdown can be given a shorter grace period', async () => {
  // Ignores stdin closing and SIGTERM: only SIGKILL stops it.
  const stubborn = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
  const transport = new ProcessTransport({ command: process.execPath, args: ['-e', stubborn], graceMs: 5000 });
  await transport.start();
  const started = Date.now();
  await transport.shutdown(100);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
});

/** Makes signals to a process group fail with `code`, after really delivering them so nothing leaks. */
function failGroupSignals(code: string): { mock: { restore(): void } } {
  const real = process.kill.bind(process);
  return mock.method(process, 'kill', (pid: number, signal?: string | number): true => {
    if (pid < 0) {
      if (code !== 'EINVAL') {
        try {
          real(pid, signal);
        } catch {
          // already gone
        }
      }
      throw Object.assign(new Error(`kill ${code}`), { code });
    }
    return real(pid, signal);
  });
}

test('shutdown resolves when signalling the group fails with EPERM or ESRCH', { skip: process.platform === 'win32' }, async () => {
  for (const code of ['EPERM', 'ESRCH']) {
    const transport = new ProcessTransport({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], graceMs: 200 });
    await transport.start();
    const stub = failGroupSignals(code);
    try {
      await transport.shutdown();
    } finally {
      stub.mock.restore();
    }
  }
});

test('a signal error other than ESRCH or EPERM still surfaces', { skip: process.platform === 'win32' }, async () => {
  const transport = new ProcessTransport({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], graceMs: 200 });
  await transport.start();
  const stub = failGroupSignals('EINVAL');
  try {
    await assert.rejects(transport.shutdown(), /EINVAL/);
  } finally {
    stub.mock.restore();
  }
  await transport.close().catch(() => undefined);
});
