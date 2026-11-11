import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { diffBaseline, formatDelta, loadBaseline } from '../src/baseline.js';
import { EXIT, main, type Io } from '../src/cli.js';
import { FootprintError } from '../src/errors.js';
import type { Report } from '../src/measure.js';
import { renderText } from '../src/render.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));

function capture(): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    env: {},
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}

/** The smallest report the diff reads. */
function report(tools: Record<string, number>, mode: Report['counter']['mode'] = 'o200k'): Report {
  const list = Object.entries(tools).map(([name, tokens]) => ({ name, tokens }));
  return {
    counter: { mode, unit: 'o200k tokens', label: 'x', tokenizer: 'o200k_base', billed: false },
    total: { tools: list.length, tokens: list.reduce((sum, t) => sum + t.tokens, 0), chars: 0, pages: null },
    tools: list,
  } as unknown as Report;
}

async function writeJson(name: string, value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'mcp-footprint-baseline-')), name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

test('diff: total, changed tools by size of change, added and removed', () => {
  const before = report({ search_issues: 300, echo: 100, ping: 50, gone: 40 });
  const after = report({ search_issues: 580, echo: 90, ping: 50, fresh: 60, newer: 2 });
  const diff = diffBaseline(before, after, 'base.json');
  assert.deepEqual(
    { before: diff.before, after: diff.after, delta: diff.delta, percent: diff.percent },
    { before: 490, after: 782, delta: 292, percent: 0.5959 },
  );
  assert.deepEqual(diff.changed, [
    { name: 'search_issues', before: 300, after: 580, delta: 280 },
    { name: 'echo', before: 100, after: 90, delta: -10 },
  ]);
  assert.deepEqual(diff.added, [
    { name: 'fresh', tokens: 60 },
    { name: 'newer', tokens: 2 },
  ]);
  assert.deepEqual(diff.removed, [{ name: 'gone', tokens: 40 }]);
  assert.equal(formatDelta(diff), '+292 tokens (+60%); search_issues +280, echo -10; 2 tools added; 1 tool removed');
});

test('diff: the one-line summary covers no change, a drop, small percentages and many tools', () => {
  assert.equal(formatDelta(diffBaseline(report({ a: 10 }), report({ a: 10 }), 'b')), 'no change (0 tokens)');
  assert.equal(formatDelta(diffBaseline(report({ a: 1000 }), report({ a: 996 }), 'b')), '-4 tokens (-0.4%); a -4');
  assert.equal(formatDelta(diffBaseline(report({}), report({ a: 5 }), 'b')), '+5 tokens; 1 tool added');
  const many = diffBaseline(report({ a: 1, b: 1, c: 1, d: 1, e: 1 }), report({ a: 6, b: 5, c: 4, d: 3, e: 2 }), 'b');
  assert.equal(formatDelta(many), '+15 tokens (+300%); a +5, b +4, c +3 and 2 more tools changed');
});

test('loadBaseline accepts a --json report and a committed reference report', async () => {
  const plain = report({ a: 1 });
  assert.equal((await loadBaseline(await writeJson('r.json', plain))).total.tokens, 1);
  const reference = JSON.parse(await readFile(fixture('../../reports/server-memory.json'), 'utf8')) as { report: Report };
  const loaded = await loadBaseline(fixture('../../reports/server-memory.json'));
  assert.equal(loaded.total.tokens, reference.report.total.tokens);
});

test('loadBaseline rejects files that are not reports, naming the problem', async () => {
  await assert.rejects(loadBaseline('/no/such/baseline.json'), /cannot read baseline \/no\/such\/baseline\.json/);
  const notJson = join(await mkdtemp(join(tmpdir(), 'mcp-footprint-baseline-')), 'x.json');
  await writeFile(notJson, '{');
  await assert.rejects(loadBaseline(notJson), /is not valid JSON/);
  for (const bad of [[], { tools: [] }, { counter: { mode: 'o200k' }, total: { tokens: 'x' }, tools: [] }, { counter: { mode: 'o200k' }, total: { tokens: 1 }, tools: [{ name: 1 }] }]) {
    await assert.rejects(loadBaseline(await writeJson('bad.json', bad)), (error: unknown) => {
      assert.ok(error instanceof FootprintError);
      assert.match(error.message, /is not an mcp-footprint report/);
      return true;
    });
  }
});

test('a baseline counted in another mode is refused', () => {
  assert.throws(() => diffBaseline(report({ a: 1 }, 'chars4'), report({ a: 1 }), 'old.json'), /old\.json was counted with chars4, this run with o200k/);
});

test('--baseline prints the delta, puts it in --json, and --budget still applies to the total', async () => {
  const toolsJson = fixture('tools.json');
  const first = capture();
  assert.equal(await main(['--json', '--from-json', toolsJson], first), EXIT.ok);
  const current = JSON.parse(first.out) as Report;
  // A baseline in which search_issues was 100 tokens smaller and ping did not exist yet.
  const older = structuredClone(current);
  older.tools = older.tools
    .filter((t) => t.name !== 'ping')
    .map((t) => (t.name === 'search_issues' ? { ...t, tokens: t.tokens - 100 } : t));
  older.total.tokens = older.tools.reduce((sum, t) => sum + t.tokens, 0);
  const path = await writeJson('baseline.json', older);

  const text = capture();
  assert.equal(await main(['--baseline', path, '--from-json', toolsJson], text), EXIT.ok);
  const ping = current.tools.find((t) => t.name === 'ping')?.tokens ?? 0;
  const delta = 100 + ping;
  assert.match(text.out, new RegExp(`\\nbaseline   \\+${delta} tokens \\(\\+\\d+(\\.\\d)?%\\) vs .*baseline\\.json\\n           search_issues \\+100; 1 tool added\\n`));

  const json = capture();
  assert.equal(await main(['--json', '--baseline', path, '--from-json', toolsJson], json), EXIT.ok);
  const withDiff = JSON.parse(json.out) as Report;
  assert.equal(withDiff.baseline?.delta, delta);
  assert.deepEqual(withDiff.baseline.added, [{ name: 'ping', tokens: ping }]);

  // The budget is on the total, not on the delta.
  const over = capture();
  assert.equal(await main(['--budget', String(current.total.tokens - 1), '--baseline', path, '--from-json', toolsJson], over), EXIT.overBudget);
  assert.equal(await main(['--budget', String(current.total.tokens), '--baseline', path, '--from-json', toolsJson], capture()), EXIT.ok);
});

test('without --baseline the report has baseline: null and no baseline line', async () => {
  const io = capture();
  await main(['--json', '--from-json', fixture('tools.json')], io);
  const plain = JSON.parse(io.out) as Report;
  assert.equal(plain.baseline, null);
  assert.doesNotMatch(renderText(plain), /baseline/);
});

test('diff: tools that share a name are compared one to one, not collapsed', () => {
  const list = (tokens: number[]): Report =>
    ({
      counter: { mode: 'o200k', unit: 'o200k tokens', label: 'x', tokenizer: 'o200k_base', billed: false },
      total: { tools: tokens.length, tokens: tokens.reduce((a, b) => a + b, 0), chars: 0, pages: null },
      tools: tokens.map((t) => ({ name: 'dup', tokens: t })),
    }) as unknown as Report;
  // Collapsed by name, the last "dup" wins and a 100 -> 100 + 50 growth looks like 50 -> 50.
  const grown = diffBaseline(list([100]), list([100, 50]), 'b.json');
  assert.deepEqual(grown.added, [{ name: 'dup', tokens: 50 }]);
  assert.deepEqual(grown.changed, []);
  const shrunk = diffBaseline(list([100, 50]), list([100]), 'b.json');
  assert.deepEqual(shrunk.removed, [{ name: 'dup', tokens: 50 }]);
  const edited = diffBaseline(list([100, 50]), list([100, 70]), 'b.json');
  assert.deepEqual(edited.changed, [{ name: 'dup', before: 50, after: 70, delta: 20 }]);
  assert.equal(diffBaseline(list([100, 50]), list([100, 50]), 'b.json').changed.length, 0);
});
