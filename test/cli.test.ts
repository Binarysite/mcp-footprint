import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT, main, parseCli, USAGE, type Io } from '../src/cli.js';
import type { Report } from '../src/measure.js';
import { VERSION } from '../src/version.js';

function capture(env: NodeJS.ProcessEnv = {}, extra: Partial<Io> = {}): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    env,
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

async function toolsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-footprint-cli-'));
  const path = join(dir, 'tools.json');
  await writeFile(
    path,
    JSON.stringify({
      tools: [
        { name: 'small', inputSchema: { type: 'object' } },
        { name: 'large', description: 'x'.repeat(400), inputSchema: { type: 'object' } },
      ],
    }),
  );
  return path;
}

test('parses options before -- and the command after it', () => {
  const parsed = parseCli(['--budget', '500', '--json', '--', 'node', 'server.js', '--port', '1']);
  assert.ok(parsed.kind === 'run');
  assert.equal(parsed.options.budget, 500);
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.count, 'o200k');
  assert.equal(parsed.options.timeoutMs, 30_000);
  assert.deepEqual(parsed.options.command, ['node', 'server.js', '--port', '1']);
});

test('accepts chars/4 as a spelling of chars4', () => {
  const parsed = parseCli(['--count', 'chars/4', '--from-json', 'x.json']);
  assert.ok(parsed.kind === 'run' && parsed.options.count === 'chars4');
});

for (const [argv, message] of [
  [['server.js'], /put the server command after --/],
  [[], /nothing to measure/],
  [['--from-json', 'a.json', '--', 'node'], /not both/],
  [['--from-json', 'a.json', '--save-tools', 'b.json'], /--save-tools needs a server/],
  [['--count', 'gpt2', '--', 'node'], /--count must be/],
  [['--budget=-1', '--', 'node'], /--budget must be a whole number/],
  [['--budget', '-1', '--', 'node'], /argument is ambiguous/],
  [['--budget', '1.5', '--', 'node'], /--budget must be a whole number/],
  [['--timeout', '0', '--', 'node'], /--timeout must be greater than 0/],
  [['--nope', '--', 'node'], /Unknown option/],
] as const) {
  test(`usage error: ${argv.join(' ') || '(no arguments)'}`, async () => {
    const io = capture();
    assert.equal(await main(argv, io), EXIT.error);
    assert.match(io.err, message);
    assert.match(io.err, /Run mcp-footprint --help for usage/);
    assert.equal(io.out, '');
  });
}

test('--help and --version', async () => {
  const help = capture();
  assert.equal(await main(['--help'], help), EXIT.ok);
  assert.equal(help.out, USAGE);
  const version = capture();
  assert.equal(await main(['-v'], version), EXIT.ok);
  assert.equal(version.out, `${VERSION}\n`);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('--from-json prints a text report and exits 0', async () => {
  const io = capture();
  assert.equal(await main(['--from-json', await toolsFile()], io), EXIT.ok);
  assert.match(io.out, /: 2 tools\n/);
  assert.match(io.out, /o200k tokens/);
  assert.equal(io.err, '');
});

test('--budget exits 1 above the total and 0 at it', async () => {
  const path = await toolsFile();
  const json = capture();
  await main(['--json', '--from-json', path], json);
  const total = (JSON.parse(json.out) as Report).total.tokens;
  assert.equal(await main(['--budget', String(total), '--from-json', path], capture()), EXIT.ok);
  const over = capture();
  assert.equal(await main(['--budget', String(total - 1), '--from-json', path], over), EXIT.overBudget);
  assert.match(over.out, /over by 1\n/);
});

test('--out writes the JSON report next to the text output', async () => {
  const path = await toolsFile();
  const out = join(await mkdtemp(join(tmpdir(), 'mcp-footprint-out-')), 'report.json');
  const io = capture();
  await main(['--count', 'chars4', '--out', out, '--from-json', path], io);
  const report = JSON.parse(await readFile(out, 'utf8')) as Report;
  assert.equal(report.counter.mode, 'chars4');
  assert.equal(report.counter.tokenizer, null);
  assert.equal(report.counter.billed, false);
  assert.match(io.out, /est\. tokens \(chars\/4\)/);
  assert.match(io.out, /an estimate, not a tokenizer/);
});

test('anthropic mode without a key fails before doing anything', async () => {
  const io = capture({});
  assert.equal(await main(['--count', 'anthropic', '--experimental', '--', 'does-not-exist'], io), EXIT.error);
  assert.match(io.err, /needs ANTHROPIC_API_KEY/);
});

test('anthropic mode uses the key, model and base URL from the environment', async () => {
  const seen: { url: string; headers: Record<string, string>; model: string }[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const body = JSON.parse(init?.body as string) as { model: string; tools?: unknown[] };
    seen.push({ url: input as string, headers: init?.headers as Record<string, string>, model: body.model });
    return Promise.resolve(Response.json({ input_tokens: 5 + (body.tools?.length ?? 0) * 100 }));
  };
  const io = capture({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.example' }, { fetch: fakeFetch });
  assert.equal(await main(['--count', 'anthropic', '--experimental', '--model', 'claude-x', '--json', '--from-json', await toolsFile()], io), EXIT.ok);
  const report = JSON.parse(io.out) as Report;
  assert.equal(report.total.tokens, 200);
  assert.equal(report.counter.model, 'claude-x');
  assert.ok(seen.every((s) => s.url === 'https://proxy.example/v1/messages/count_tokens' && s.headers['x-api-key'] === 'k' && s.model === 'claude-x'));
});

test('reports API errors as exit 2', async () => {
  const io = capture({ ANTHROPIC_API_KEY: 'k' }, { fetch: () => Promise.resolve(Response.json({ error: { message: 'nope' } }, { status: 400 })) });
  assert.equal(await main(['--count', 'anthropic', '--experimental', '--from-json', await toolsFile()], io), EXIT.error);
  assert.match(io.err, /HTTP 400: nope/);
});

test('unexpected errors are reported, not thrown', async () => {
  const io = capture({}, {
    stdout: () => {
      throw new Error('stdout closed');
    },
  });
  assert.equal(await main(['--from-json', await toolsFile()], io), EXIT.error);
  assert.match(io.err, /unexpected error: Error: stdout closed/);
});

test('error messages that echo untrusted text cannot carry escape sequences', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-footprint-cli-'));
  const path = join(dir, 'bad.json');
  await writeFile(path, JSON.stringify({ tools: [{ name: '\u001b[2Jx', description: 5, inputSchema: {} }] }));
  const io = capture();
  assert.equal(await main(['--from-json', path], io), EXIT.error);
  assert.equal(io.err.includes('\u001b'), false);
  assert.match(io.err, /not a string/);
});

test('anthropic mode refuses an insecure base URL before any request', async () => {
  const io = capture({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://proxy.example' });
  assert.equal(await main(['--count', 'anthropic', '--experimental', '--from-json', await toolsFile()], io), EXIT.error);
  assert.match(io.err, /https/);
});

test('Ctrl-C interrupts anthropic mode', async () => {
  const controller = new AbortController();
  const io = capture(
    { ANTHROPIC_API_KEY: 'k' },
    {
      signal: controller.signal,
      fetch: (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
          setTimeout(() => {
    controller.abort();
  }, 10);
        }),
    },
  );
  assert.equal(await main(['--count', 'anthropic', '--experimental', '--from-json', await toolsFile()], io), EXIT.interrupted);
});

test('--timeout bounds each anthropic request', async () => {
  const io = capture(
    { ANTHROPIC_API_KEY: 'k' },
    {
      fetch: (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    },
  );
  assert.equal(await main(['--count', 'anthropic', '--experimental', '--timeout', '30', '--from-json', await toolsFile()], io), EXIT.error);
  assert.match(io.err, /timed out after 30 ms/);
});

test('a 50,000-character description is counted, and quickly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-footprint-cli-'));
  const path = join(dir, 'long.json');
  await writeFile(path, JSON.stringify({ tools: [{ name: 'long', description: 'a'.repeat(50_000), inputSchema: { type: 'object' } }] }));
  const io = capture();
  const started = Date.now();
  assert.equal(await main(['--json', '--from-json', path], io), EXIT.ok);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `took ${elapsed} ms`);
  assert.ok((JSON.parse(io.out) as Report).total.tokens > 0);
});

test('a tool over 64 KB is exit 2 with a message that says why', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-footprint-cli-'));
  const path = join(dir, 'huge.json');
  await writeFile(path, JSON.stringify({ tools: [{ name: 'huge', description: 'a'.repeat(70_000), inputSchema: { type: 'object' } }] }));
  const io = capture();
  assert.equal(await main(['--from-json', path], io), EXIT.error);
  assert.match(io.err, /tool "huge" is 70,\d{3} bytes as JSON; the limit is 65,536/);
});

test('--timeout also bounds counting', async () => {
  const io = capture();
  assert.equal(await main(['--timeout', '1', '--from-json', await toolsFile()], io), EXIT.error);
  assert.match(io.err, /timed out after 1 ms counting tokens/);
});

test('--count anthropic needs --experimental, and says why', async () => {
  const io = capture({ ANTHROPIC_API_KEY: 'k' }, { fetch: () => Promise.reject(new Error('must not be called')) });
  assert.equal(await main(['--count', 'anthropic', '--from-json', await toolsFile()], io), EXIT.error);
  assert.match(io.err, /--count anthropic is experimental: it has been tested against a mocked API only.*add --experimental/s);
  assert.throws(() => parseCli(['--experimental', '--from-json', 'x.json']), /--experimental only applies to --count anthropic/);
});

test('the o200k label says what the number is and is not', async () => {
  const io = capture();
  assert.equal(await main(['--json', '--from-json', await toolsFile()], io), EXIT.ok);
  const label = "o200k_base tokens of each tool's JSON (a comparable size, not any provider's billed count)";
  assert.equal((JSON.parse(io.out) as Report).counter.label, label);
  const text = capture();
  await main(['--from-json', await toolsFile()], text);
  assert.ok(text.out.includes(`counted with ${label}`));
  assert.doesNotMatch(text.out + USAGE, /exact/);
  const counter = (JSON.parse(io.out) as Report).counter as unknown as Record<string, unknown>;
  assert.equal(counter.tokenizer, 'o200k_base');
  assert.equal(counter.billed, false);
  assert.ok(!('exact' in counter));
});
