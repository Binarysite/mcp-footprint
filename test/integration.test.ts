import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, main, type Io } from '../src/cli.js';
import type { Report } from '../src/measure.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
const server = fixture('server.mjs');
const hangServer = fixture('hang-server.mjs');
const toolsJson = fixture('tools.json');
const bin = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const node = process.execPath;
const posix = process.platform !== 'win32';

function capture(extra: Partial<Io> = {}): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    env: process.env,
    graceMs: 200,
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
    ...extra,
  };
  return io;
}

async function run(argv: string[], extra: Partial<Io> = {}): Promise<{ code: number; out: string; err: string; report?: Report }> {
  const io = capture(extra);
  const code = await main(argv, io);
  const report = argv.includes('--json') && code !== EXIT.error ? (JSON.parse(io.out) as Report) : undefined;
  return { code, out: io.out, err: io.err, ...(report && { report }) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pids: number[], ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !alive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pids.every((pid) => !alive(pid));
}

test('measures a live server the same as its saved tools/list result', async () => {
  const live = await run(['--json', '--', node, server]);
  const saved = await run(['--json', '--from-json', toolsJson]);
  assert.equal(live.code, EXIT.ok);
  assert.ok(live.report && saved.report);
  assert.deepEqual(live.report.server, { name: 'fixture', version: '1.2.3' });
  assert.deepEqual(live.report.tools, saved.report.tools);
  assert.equal(live.report.total.tokens, saved.report.total.tokens);
  assert.equal(live.report.total.pages, 1);
  assert.deepEqual(live.report.source, { kind: 'stdio', command: [node, server] });
  assert.deepEqual(
    live.report.tools.map((t) => t.name),
    ['bulk_import', 'search_issues', 'echo', 'ping'],
  );
});

test('follows pagination across pages of one tool each', async () => {
  const paged = await run(['--json', '--', node, server, '--page-size', '1']);
  const whole = await run(['--json', '--', node, server]);
  assert.equal(paged.report?.total.pages, 4);
  assert.deepEqual(paged.report.tools, whole.report?.tools);
});

test('fails with exit 2 when the server repeats a cursor', async () => {
  const result = await run(['--', node, server, '--repeat-cursor']);
  assert.equal(result.code, EXIT.error);
  assert.match(result.err, /tools\/list: server sent nextCursor "1" twice/);
});

test('lists prompts and resources only when advertised', async () => {
  const withExtras = await run(['--json', '--', node, server]);
  assert.equal(withExtras.report?.prompts?.count, 1);
  assert.equal(withExtras.report.resources?.count, 2);
  const without = await run(['--json', '--', node, server, '--no-extras']);
  assert.equal(without.report?.prompts, null);
  assert.equal(without.report.resources, null);
  const text = await run(['--', node, server, '--no-extras']);
  assert.doesNotMatch(text.out, /prompts|resources/);
});

test('--budget sets the exit code against a live server', async () => {
  const total = (await run(['--json', '--', node, server])).report?.total.tokens ?? 0;
  assert.ok(total > 0);
  assert.equal((await run(['--budget', String(total), '--', node, server])).code, EXIT.ok);
  const over = await run(['--budget', String(total - 1), '--', node, server]);
  assert.equal(over.code, EXIT.overBudget);
  assert.match(over.out, /over by 1\n$/);
});

test('--save-tools writes the raw tools/list result', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'mcp-footprint-save-')), 'tools.json');
  assert.equal((await run(['--save-tools', path, '--', node, server])).code, EXIT.ok);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), JSON.parse(await readFile(toolsJson, 'utf8')));
});

test('works through a shell wrapper', { skip: !posix }, async () => {
  const result = await run(['--json', '--', 'sh', '-c', `exec "${node}" "${server}"`]);
  assert.equal(result.code, EXIT.ok);
  assert.equal(result.report?.total.tools, 4);
});

test('a hung server times out and its whole process group is killed', { skip: !posix }, async () => {
  const pidFile = join(await mkdtemp(join(tmpdir(), 'mcp-footprint-hang-')), 'pids');
  const started = Date.now();
  const result = await run(['--timeout', '300', '--', node, hangServer, pidFile]);
  const elapsed = Date.now() - started;
  assert.equal(result.code, EXIT.error);
  assert.match(result.err, /timed out after 300 ms waiting for initialize/);
  const pids = (await readFile(pidFile, 'utf8')).split(' ').map(Number);
  assert.equal(pids.length, 2);
  // Both ignore SIGTERM, so this proves the SIGKILL reached the group.
  assert.ok(await waitUntilDead(pids, 2000), `still alive: ${pids.filter(alive).join(', ')}`);
  // 300 ms deadline + 200 ms after closing stdin + 200 ms after SIGTERM.
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
});

test('a server that exits early is reported with its stderr', async () => {
  const result = await run(['--', node, '-e', 'console.error("missing config file"); process.exit(3)']);
  assert.equal(result.code, EXIT.error);
  assert.match(result.err, /server exited \(code 3\) during initialize/);
  assert.match(result.err, /last server stderr:\nmissing config file/);
});

test('a command that does not exist is a clear error', async () => {
  const result = await run(['--', 'mcp-footprint-no-such-command']);
  assert.equal(result.code, EXIT.error);
  assert.match(result.err, /could not start mcp-footprint-no-such-command: spawn mcp-footprint-no-such-command ENOENT/);
});

test('--verbose passes the server stderr through', async () => {
  const result = await run(['--verbose', '--', node, '-e', 'console.error("hello from stderr"); process.exit(1)']);
  assert.match(result.err, /^hello from stderr\n/);
});

test('the bin exits 1 over budget, as a real process', async () => {
  const child = spawn(node, [bin, '--budget', '1', '--', node, server], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [code] = (await once(child, 'exit')) as [number];
  assert.equal(code, EXIT.overBudget);
});

test('Ctrl-C on the bin stops the server group and exits 130', { skip: !posix }, async () => {
  const pidFile = join(await mkdtemp(join(tmpdir(), 'mcp-footprint-int-')), 'pids');
  const child = spawn(node, [bin, '--timeout', '60000', '--', node, hangServer, pidFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const deadline = Date.now() + 5000;
  let pids: number[] = [];
  while (Date.now() < deadline && pids.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    pids = await readFile(pidFile, 'utf8').then((text) => text.split(' ').map(Number), () => []);
  }
  child.kill('SIGINT');
  const [code] = (await once(child, 'exit')) as [number];
  assert.equal(code, EXIT.interrupted);
  assert.match(stderr, /interrupted/);
  assert.ok(await waitUntilDead(pids, 6000), `still alive: ${pids.filter(alive).join(', ')}`);
});

test('after a timeout the server gets a short grace, not the full one', { skip: !posix }, async () => {
  const pidFile = join(await mkdtemp(join(tmpdir(), 'mcp-footprint-hang-')), 'pids');
  const started = Date.now();
  // The normal 2 s grace per step, as the bin uses it.
  const result = await run(['--timeout', '1500', '--', node, hangServer, pidFile], { graceMs: 2000 });
  const elapsed = Date.now() - started;
  assert.equal(result.code, EXIT.error);
  assert.match(result.err, /timed out after 1500 ms waiting for initialize/);
  // 1500 ms deadline + 200 ms after closing stdin + 200 ms after SIGTERM; it took 6.0 s before.
  assert.ok(elapsed < 2300, `took ${elapsed} ms`);
});

test('a server that floods stdout without a newline fails fast with a clear message', async () => {
  const flood = 'const chunk = "x".repeat(65536); const write = () => { while (process.stdout.write(chunk)); }; process.stdout.on("drain", write); write(); process.stdin.resume();';
  const started = Date.now();
  const result = await run(['--timeout', '60000', '--', node, '-e', flood], { graceMs: 2000 });
  const elapsed = Date.now() - started;
  assert.equal(result.code, EXIT.error);
  assert.match(result.err, /server wrote more than 64 MB without ending a message; stopping it/);
  assert.ok(elapsed < 10_000, `took ${elapsed} ms`);
});

test('a schema too deep for the SDK to validate is a clear error', async () => {
  const result = await run(['--', node, fixture('raw-server.mjs'), 'deep', '2000']);
  assert.equal(result.code, EXIT.error);
  assert.match(result.err, /tools\/list failed: the result is nested too deep for the MCP SDK to validate/);
  assert.doesNotMatch(result.err, /Maximum call stack/);
});

test('an invalid inputSchema is reported by its first problem, not a dump', async () => {
  const result = await run(['--', node, fixture('raw-server.mjs'), 'invalid']);
  assert.equal(result.code, EXIT.error);
  assert.match(result.err, /tools\/list failed: Invalid result for tools\/list: tools\.0\.inputSchema\.type: Invalid input: expected "object" \(and 59 more problems\)/);
  assert.ok(result.err.length < 400, `${result.err.length} chars`);
});

test('EPERM from the group sweep (macOS, zombies) does not replace the real error', { skip: !posix }, async () => {
  const pidFile = join(await mkdtemp(join(tmpdir(), 'mcp-footprint-eperm-')), 'pids');
  const real = process.kill.bind(process);
  const stub = mock.method(process, 'kill', (pid: number, signal?: string | number): true => {
    if (pid < 0) {
      // Do the work so nothing leaks, then fail the way macOS does.
      try {
        real(pid, signal);
      } catch {
        // already gone
      }
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    }
    return real(pid, signal);
  });
  try {
    const result = await run(['--timeout', '800', '--', node, hangServer, pidFile], { graceMs: 200 });
    assert.equal(result.code, EXIT.error);
    assert.match(result.err, /timed out after 800 ms waiting for initialize/);
    assert.doesNotMatch(result.err, /EPERM|unexpected error/);
  } finally {
    stub.mock.restore();
  }
});
