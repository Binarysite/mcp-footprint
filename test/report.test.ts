import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Counter, CounterInfo, ToolCounts } from '../src/counters.js';
import { FootprintError } from '../src/errors.js';
import { loadTools, parseTools } from '../src/load.js';
import { MAX_TOOL_BYTES, measure, withBudget, type MeasureInput } from '../src/measure.js';
import { renderJson, renderText } from '../src/render.js';
import type { ToolDefinition } from '../src/serialize.js';

/** Counts one token per character of the tool name times 10, so expected values are obvious. */
class FakeCounter implements Counter {
  readonly info: CounterInfo = { mode: 'o200k', unit: 'fake tokens', label: 'a fake counter', exact: true };
  constructor(readonly overhead = 0) {}
  countTools(definitions: readonly ToolDefinition[]): Promise<ToolCounts> {
    const perTool = definitions.map((d) => d.name.length * 10);
    const sum = perTool.reduce((a, b) => a + b, 0);
    return Promise.resolve({ perTool, total: sum + this.overhead, overhead: this.overhead });
  }
  countText(text: string): Promise<number> {
    return Promise.resolve(text.length);
  }
}

const input: MeasureInput = {
  source: { kind: 'stdio', command: ['node', 'server.js'] },
  server: { name: 'demo', version: '1.0.0' },
  pages: 2,
  tools: [
    { name: 'ab', inputSchema: { type: 'object' } },
    {
      name: 'abcdef',
      description: 'A longer description.',
      inputSchema: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } },
    },
    { name: 'abcd', description: 'Short.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  ],
  prompts: [{ name: 'p', description: 'd', title: 'ignored' }],
  resources: [],
};

test('sorts by cost and computes shares, sizes and offenders', async () => {
  const report = await measure(input, new FakeCounter());
  assert.deepEqual(
    report.tools.map((t) => [t.name, t.tokens, t.share]),
    [
      ['abcdef', 60, 0.5],
      ['abcd', 40, 0.3333],
      ['ab', 20, 0.1667],
    ],
  );
  assert.deepEqual(report.total, { tools: 3, tokens: 120, chars: report.tools.reduce((s, t) => s + t.chars, 0), pages: 2 });
  const [first] = report.tools;
  assert.ok(first);
  assert.equal(first.descriptionChars, 'A longer description.'.length);
  assert.equal(first.schemaDepth, 5);
  assert.equal(first.schemaProperties, 2);
  assert.deepEqual(report.offenders.longestDescriptions, [
    { name: 'abcdef', value: 21 },
    { name: 'abcd', value: 6 },
  ]);
  assert.deepEqual(
    report.offenders.deepestSchemas.map((r) => r.name),
    ['abcdef', 'abcd', 'ab'],
  );
  assert.deepEqual(report.prompts, { count: 1, tokens: JSON.stringify([{ name: 'p', description: 'd' }]).length });
  assert.deepEqual(report.resources, { count: 0, tokens: 0 });
  assert.equal(report.budget, null);
});

test('budget compares the total, and equal is within budget', async () => {
  const report = await measure(input, new FakeCounter());
  assert.equal(withBudget(report, 120).budget?.over, false);
  assert.equal(withBudget(report, 119).budget?.over, true);
  assert.equal(withBudget(report, undefined).budget, null);
});

test('renders a stable text report', async () => {
  const report = withBudget(await measure(input, new FakeCounter(30)), 100);
  assert.equal(
    renderText(report),
    [
      'demo 1.0.0: 3 tools, 2 pages',
      'counted with a fake counter',
      '',
      '  fake tokens   share  tool',
      '           60   40.0%  abcdef',
      '           40   26.7%  abcd',
      '           20   13.3%  ab',
      '           30   20.0%  (tool-use overhead, not tied to one tool)',
      '          150  100.0%  total',
      '',
      'longest descriptions  abcdef (21 chars), abcd (6 chars)',
      'deepest schemas       abcdef (depth 5), abcd (depth 3), ab (depth 1)',
      'biggest schemas       abcdef (91 chars), abcd (54 chars), ab (17 chars)',
      '',
      'prompts    1, 32 fake tokens (not in the total)',
      'resources  0, 0 fake tokens (not in the total)',
      '',
      'budget     150 of 100 fake tokens: over by 50',
      '',
    ].join('\n'),
  );
});

test('renders an empty server and a file source', async () => {
  const report = await measure(
    { source: { kind: 'file', path: 'tools.json' }, server: null, pages: null, tools: [], prompts: null, resources: null },
    new FakeCounter(),
  );
  assert.equal(
    renderText(withBudget(report, 0)),
    [
      'tools.json: 0 tools',
      'counted with a fake counter',
      '',
      '  fake tokens   share  tool',
      '            0       -  total',
      '',
      'budget     0 of 0 fake tokens: ok',
      '',
    ].join('\n'),
  );
});

test('JSON output round-trips the report', async () => {
  const report = await measure(input, new FakeCounter());
  assert.deepEqual(JSON.parse(renderJson(report)), report);
});

test('loads the three accepted file shapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-footprint-'));
  const tool = { name: 't', description: 'd', inputSchema: { type: 'object' }, title: 'dropped later' };
  const shapes = [[tool], { tools: [tool] }, { jsonrpc: '2.0', id: 1, result: { tools: [tool] } }];
  for (const [i, shape] of shapes.entries()) {
    const path = join(dir, `${i}.json`);
    await writeFile(path, JSON.stringify(shape));
    assert.deepEqual(await loadTools(path), [{ name: 't', description: 'd', inputSchema: { type: 'object' } }]);
  }
});

test('rejects malformed files with a message that names the problem', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-footprint-'));
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{ not json');
  await assert.rejects(loadTools(bad), (e: unknown) => e instanceof FootprintError && /not valid JSON/.test(e.message));
  await assert.rejects(loadTools(join(dir, 'missing.json')), /cannot read/);
  assert.throws(() => parseTools({ items: [] }, 'x'), /expected an array of tools/);
  assert.throws(() => parseTools([{ inputSchema: {} }], 'x'), /tool 0 has no name/);
  assert.throws(() => parseTools([{ name: 'a', description: 3, inputSchema: {} }], 'x'), /description that is not a string/);
  assert.throws(() => parseTools([{ name: 'a', inputSchema: [] }], 'x'), /no inputSchema object/);
});

const ESC = String.fromCharCode(27);
const hasControl = (text: string): boolean => Array.from(text).some((c) => (c !== '\n' && c.charCodeAt(0) < 32) || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));

test('text output neutralises terminal control characters from the server', async () => {
  const hostile: MeasureInput = {
    source: { kind: 'stdio', command: [`${ESC}]0;pwned\u0007cmd`] },
    server: { name: `evil${ESC}[2J`, version: '1\r2' },
    tools: [{ name: `a${ESC}[2Jb\nfake  100.0%  row`, description: 'd', inputSchema: { type: 'object' } }],
    pages: 1,
    prompts: null,
    resources: null,
  };
  const report = await measure(hostile, new FakeCounter());
  const text = renderText(report);
  assert.equal(hasControl(text), false);
  assert.match(text, /a\uFFFD\[2Jb\uFFFDfake/);
  assert.match(text, /evil\uFFFD\[2J 1\uFFFD2/);
  const file = renderText({ ...report, server: null, source: { kind: 'file', path: `x${ESC}[2Jy` }, tools: [] });
  assert.equal(file.includes(ESC), false);
  const cmd = renderText({ ...report, server: null });
  assert.equal(hasControl(cmd), false);
  // JSON stays raw: JSON.stringify already escapes control characters.
  assert.deepEqual(JSON.parse(renderJson(report)), report);
  assert.equal(renderJson(report).includes(ESC), false);
});

test('long names are truncated in the text report', async () => {
  const report = await measure(
    { ...input, tools: [{ name: 'n'.repeat(500), inputSchema: { type: 'object' } }] },
    new FakeCounter(),
  );
  const text = renderText(report);
  assert.ok(!text.includes('n'.repeat(200)));
  assert.match(text, /n…/);
});

test('a schema too deep to serialize is a FootprintError, not a crash', async () => {
  let schema: Record<string, unknown> = {};
  for (let i = 0; i < 100_000; i++) schema = { a: schema };
  await assert.rejects(
    measure({ ...input, tools: [{ name: 'deep', inputSchema: schema }] }, new FakeCounter()),
    (error: unknown) => error instanceof FootprintError && /deep/.test(error.message),
  );
});

test('a tool definition over 64 KB serialized is refused before counting', async () => {
  let counted = false;
  const counter = new FakeCounter();
  counter.countTools = () => {
    counted = true;
    return Promise.resolve({ perTool: [], total: 0, overhead: 0 });
  };
  const huge = { name: 'huge', description: 'a'.repeat(MAX_TOOL_BYTES), inputSchema: { type: 'object' } };
  await assert.rejects(measure({ ...input, tools: [huge] }, counter), (error: unknown) => {
    assert.ok(error instanceof FootprintError);
    assert.match(error.message, /tool "huge" is 65,\d{3} bytes as JSON; the limit is 65,536/);
    return true;
  });
  assert.equal(counted, false);
  // Just under the limit is fine.
  const fits = { ...huge, description: 'a'.repeat(MAX_TOOL_BYTES - 100) };
  assert.equal((await measure({ ...input, tools: [fits] }, new FakeCounter())).total.tools, 1);
});

test('duplicate tool names are a warning in the report', async () => {
  const tools = [
    { name: 'dup', inputSchema: { type: 'object' } },
    { name: 'dup', description: 'again', inputSchema: { type: 'object' } },
    { name: 'solo', inputSchema: { type: 'object' } },
  ];
  const report = await measure({ ...input, tools }, new FakeCounter());
  assert.deepEqual(report.warnings, ['2 tools are named "dup"; a client may reject the server or keep only one of them']);
  assert.match(renderText(report), /\nwarning: 2 tools are named "dup"; a client may reject the server or keep only one of them\n$/);
  assert.deepEqual((await measure(input, new FakeCounter())).warnings, []);
});
