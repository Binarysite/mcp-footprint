import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSdkError, MAX_PAGES, paginate } from '../src/collect.js';
import { FootprintError } from '../src/errors.js';

test('follows nextCursor until it is absent', async () => {
  const pages: Record<string, { items: number[]; nextCursor?: string }> = {
    start: { items: [1, 2], nextCursor: 'a' },
    a: { items: [3], nextCursor: 'b' },
    b: { items: [4] },
  };
  const seen: (string | undefined)[] = [];
  const result = await paginate('tools/list', (cursor) => {
    seen.push(cursor);
    return Promise.resolve(pages[cursor ?? 'start'] ?? { items: [] });
  });
  assert.deepEqual(result, { items: [1, 2, 3, 4], pages: 3 });
  assert.deepEqual(seen, [undefined, 'a', 'b']);
});

test('treats an empty nextCursor as the last page', async () => {
  const result = await paginate('tools/list', () => Promise.resolve({ items: ['x'], nextCursor: '' }));
  assert.deepEqual(result, { items: ['x'], pages: 1 });
});

test('stops when the server repeats a cursor', async () => {
  await assert.rejects(
    paginate('tools/list', () => Promise.resolve({ items: [], nextCursor: 'same' })),
    (error: unknown) => error instanceof FootprintError && /nextCursor "same" twice/.test(error.message),
  );
});

test(`stops after ${MAX_PAGES} pages`, async () => {
  let n = 0;
  await assert.rejects(
    paginate('tools/list', () => Promise.resolve({ items: [], nextCursor: String(n++) })),
    /more than 1000 pages/,
  );
  assert.equal(n, MAX_PAGES);
});

test('a page with hundreds of thousands of items does not overflow the stack', async () => {
  const big = Array.from({ length: 500_000 }, (_, i) => i);
  const result = await paginate('tools/list', () => Promise.resolve({ items: big }));
  assert.equal(result.items.length, 500_000);
});

test('describeSdkError keeps the first validation problem and passes other errors through', () => {
  const invalid = (issues: unknown): Error => new Error(`Invalid result for tools/list: ${JSON.stringify(issues, null, 2)}`);
  assert.equal(
    describeSdkError(invalid([{ path: ['tools', 0, 'name'], message: 'Required' }])),
    'Invalid result for tools/list: tools.0.name: Required',
  );
  assert.equal(
    describeSdkError(invalid([{ message: 'Bad' }, { message: 'Worse' }])),
    'Invalid result for tools/list: Bad (and 1 more problem)',
  );
  assert.equal(describeSdkError(invalid([{ path: [] }])), 'Invalid result for tools/list: invalid');
  assert.equal(describeSdkError(invalid([])), 'Invalid result for tools/list: []');
  assert.equal(describeSdkError(new Error('Invalid result for tools/list: [not json]')), 'Invalid result for tools/list: [not json]');
  assert.equal(describeSdkError(new Error('Connection closed')), 'Connection closed');
  assert.match(describeSdkError(new RangeError('Maximum call stack size exceeded')), /nested too deep/);
});
