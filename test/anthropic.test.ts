import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANTHROPIC_VERSION, AnthropicCounter, DEFAULT_ANTHROPIC_MODEL } from '../src/anthropic.js';
import type { ToolDefinition } from '../src/serialize.js';

interface Body {
  model: string;
  messages: { role: string; content: string }[];
  tools?: ToolDefinition[];
}

const tools: ToolDefinition[] = [
  { name: 'a', input_schema: { type: 'object' } },
  { name: 'b', input_schema: { type: 'object' } },
  { name: 'c', input_schema: { type: 'object' } },
];

/** A fake count_tokens: 10 for the probe, 300 for any tools at all, plus a fixed cost per tool. */
const cost: Record<string, number> = { a: 50, b: 20, c: 5 };
function fakeFetch(calls: { url: string; init: RequestInit; body: Body }[]): typeof fetch {
  return (input, init) => {
    const body = JSON.parse(init?.body as string) as Body;
    calls.push({ url: input as string, init: init ?? {}, body });
    const toolTokens = body.tools ? 300 + body.tools.reduce((sum, t) => sum + (cost[t.name] ?? 0), 0) : 0;
    const content = body.messages[0]?.content ?? '';
    return Promise.resolve(Response.json({ input_tokens: 10 + toolTokens + content.length - 1 }));
  };
}

test('sends the documented request: endpoint, headers, model, messages, tools', async () => {
  const calls: { url: string; init: RequestInit; body: Body }[] = [];
  const counter = new AnthropicCounter({ apiKey: 'test-key', fetch: fakeFetch(calls) });
  await counter.countTools(tools);
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.url, 'https://api.anthropic.com/v1/messages/count_tokens');
  assert.equal(first.init.method, 'POST');
  assert.deepEqual(first.init.headers, {
    'x-api-key': 'test-key',
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  });
  assert.equal(first.body.model, DEFAULT_ANTHROPIC_MODEL);
  assert.deepEqual(first.body.messages, [{ role: 'user', content: 'x' }]);
  assert.equal(first.body.tools, undefined);
  assert.deepEqual(calls[1]?.body.tools, tools);
});

test('total is the difference with and without tools; per tool is the marginal cost', async () => {
  const calls: { url: string; init: RequestInit; body: Body }[] = [];
  const counter = new AnthropicCounter({ apiKey: 'k', model: 'claude-test', fetch: fakeFetch(calls) });
  const counts = await counter.countTools(tools);
  assert.equal(calls.length, tools.length + 2);
  assert.deepEqual(counts.perTool, [50, 20, 5]);
  assert.equal(counts.total, 375);
  assert.equal(counts.overhead, 300);
  assert.equal(counter.info.model, 'claude-test');
  assert.match(counter.info.label, /claude-test/);
});

test('a single tool carries the whole difference', async () => {
  const counter = new AnthropicCounter({ apiKey: 'k', fetch: fakeFetch([]) });
  assert.deepEqual(await counter.countTools([tools[0] as ToolDefinition]), { perTool: [350], total: 350, overhead: 0 });
});

test('no tools means no requests', async () => {
  const calls: { url: string; init: RequestInit; body: Body }[] = [];
  const counter = new AnthropicCounter({ apiKey: 'k', fetch: fakeFetch(calls) });
  assert.deepEqual(await counter.countTools([]), { perTool: [], total: 0, overhead: 0 });
  assert.equal(calls.length, 0);
});

test('countText is relative to the probe message', async () => {
  const counter = new AnthropicCounter({ apiKey: 'k', fetch: fakeFetch([]) });
  assert.equal(await counter.countText('abcd'), 3);
});

test('uses a custom base URL without a doubled slash', async () => {
  const calls: { url: string; init: RequestInit; body: Body }[] = [];
  const counter = new AnthropicCounter({ apiKey: 'k', baseUrl: 'http://proxy.example/', fetch: fakeFetch(calls) });
  await counter.countText('a');
  assert.equal(calls[0]?.url, 'http://proxy.example/v1/messages/count_tokens');
});

test('retries 429 and 5xx, then succeeds', async () => {
  const statuses = [429, 529];
  const counter = new AnthropicCounter({
    apiKey: 'k',
    retryDelayMs: 1,
    concurrency: 1,
    fetch: () => {
      const status = statuses.shift();
      return Promise.resolve(status ? new Response('busy', { status }) : Response.json({ input_tokens: 7 }));
    },
  });
  assert.equal(await counter.countText('x'), 0);
  assert.equal(statuses.length, 0);
});

test('honours retry-after in seconds', async () => {
  let calls = 0;
  const started = Date.now();
  const counter = new AnthropicCounter({
    apiKey: 'k',
    concurrency: 1,
    fetch: () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '0.05' } })
          : Response.json({ input_tokens: 1 }),
      );
    },
  });
  await counter.countText('x');
  assert.ok(Date.now() - started >= 40);
});

test('reports the API error message', async () => {
  const counter = new AnthropicCounter({
    apiKey: 'bad',
    fetch: () =>
      Promise.resolve(
        Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
      ),
  });
  await assert.rejects(counter.countText('x'), /HTTP 401: invalid x-api-key/);
});

test('gives up after the retries', async () => {
  const counter = new AnthropicCounter({
    apiKey: 'k',
    retries: 1,
    retryDelayMs: 1,
    fetch: () => Promise.resolve(new Response('<html>overloaded</html>', { status: 503 })),
  });
  await assert.rejects(counter.countText('x'), /HTTP 503: <html>overloaded/);
});

test('rejects a response without input_tokens', async () => {
  const counter = new AnthropicCounter({ apiKey: 'k', fetch: () => Promise.resolve(Response.json({ tokens: 3 })) });
  await assert.rejects(counter.countText('x'), /no input_tokens/);
});

test('wraps network errors', async () => {
  const counter = new AnthropicCounter({ apiKey: 'k', fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
  await assert.rejects(counter.countText('x'), /request failed: ECONNREFUSED/);
});
