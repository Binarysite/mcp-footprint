import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chars4Counter, O200kCounter } from '../src/counters.js';
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
