import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PAGES, paginate } from '../src/collect.js';
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
