import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chars4Counter, O200kCounter } from '../src/counters.js';
import { TimeoutError } from '../src/errors.js';
import { loadO200k } from '../src/o200k.js';
import { serialize, type ToolDefinition } from '../src/serialize.js';

const tools: ToolDefinition[] = [
  { name: 'a', description: 'First tool.', input_schema: { type: 'object' } },
  { name: 'b', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
];

test('o200k matches the reference token ids for a known string', async () => {
  const { Tiktoken } = await import('js-tiktoken/lite');
  const { default: ranks } = await import('js-tiktoken/ranks/o200k_base');
  // Reference ids from OpenAI's tiktoken for o200k_base.
  assert.deepEqual(new Tiktoken(ranks).encode('hello world'), [24912, 2375]);
  const counter = await O200kCounter.load();
  assert.equal(await counter.countText('hello world'), 2);
  assert.equal(counter.info.exact, true);
});

test('o200k counts special-token strings as plain text', async () => {
  const counter = await O200kCounter.load();
  assert.ok((await counter.countText('<|endoftext|>')) > 1);
});

test('local counters total the per-tool counts with no overhead', async () => {
  const counter = await O200kCounter.load();
  const counts = await counter.countTools(tools);
  assert.equal(counts.perTool.length, 2);
  assert.equal(counts.total, (counts.perTool[0] ?? 0) + (counts.perTool[1] ?? 0));
  assert.equal(counts.overhead, 0);
});

test('chars/4 rounds up and says it is an estimate', async () => {
  const counter = new Chars4Counter();
  assert.equal(await counter.countText('abcde'), 2);
  assert.equal(counter.info.exact, false);
  assert.match(counter.info.label, /estimate/);
  const counts = await counter.countTools(tools);
  assert.deepEqual(
    counts.perTool,
    tools.map((t) => Math.ceil(serialize(t).length / 4)),
  );
});

test('o200k counts a 50,000-character run of one letter quickly', async () => {
  // js-tiktoken's merge is quadratic here: 10 KB of "a" took 6.5 s.
  const counter = await O200kCounter.load();
  const started = Date.now();
  const tokens = await counter.countText('a'.repeat(50_000));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  assert.ok(tokens > 0 && tokens < 50_000);
});

test('o200k gives the same ids as js-tiktoken on mixed and repetitive text', async () => {
  const { Tiktoken } = await import('js-tiktoken/lite');
  const { default: ranks } = await import('js-tiktoken/ranks/o200k_base');
  const reference = new Tiktoken(ranks);
  const encoder = await loadO200k();
  // A fixed pseudo-random generator, so a failure is reproducible.
  let seed = 42;
  const random = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  const alphabet = ['a', 'b', 'Z', ' ', '\n', '{', '"', ':', '1', '9', 'é', 'ß', '中', '😀', '_', '-', '<|endoftext|>'];
  const samples = [
    'a'.repeat(1500),
    'ab'.repeat(700),
    ' '.repeat(900) + 'x',
    '{"type":"object"}'.repeat(80),
    '\u{1F600}'.repeat(300),
    'x\uD800y',
    ...Array.from({ length: 60 }, () => Array.from({ length: 200 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')),
  ];
  for (const text of samples) {
    assert.deepEqual(encoder.encode(text), reference.encode(text, [], []), JSON.stringify(text.slice(0, 40)));
  }
});

test('o200k in a worker matches in-process counts and is closed cleanly', async () => {
  const local = await O200kCounter.load();
  const worker = O200kCounter.inWorker({ deadline: Date.now() + 30_000, timeoutMs: 30_000 });
  try {
    assert.deepEqual(await worker.countTools(tools), await local.countTools(tools));
    assert.equal(await worker.countText('hello world'), 2);
  } finally {
    await worker.close();
  }
  await assert.rejects(worker.countText('x'), /closed/);
});

test('o200k in a worker is stopped at the deadline', async () => {
  // The rank table alone takes longer than 1 ms to load, so the deadline always wins.
  const worker = O200kCounter.inWorker({ deadline: Date.now() + 1, timeoutMs: 1 });
  try {
    await assert.rejects(worker.countText('a'.repeat(1000)), (error: Error) => {
      assert.ok(error instanceof TimeoutError);
      assert.match(error.message, /timed out after 1 ms counting tokens/);
      return true;
    });
  } finally {
    await worker.close();
  }
});
