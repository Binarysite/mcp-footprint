/**
 * The o200k_base encoding, with a byte-pair merge that stays fast on hostile
 * input.
 *
 * js-tiktoken 1.0.21 merges by rescanning every adjacent pair after each
 * merge, which is quadratic in the length of one regex piece: a description
 * of 10,000 "a" characters took 6.5 s, and 40,000 more than 80 s. This file
 * uses js-tiktoken's rank table and split pattern unchanged and replaces only
 * the merge with a priority queue. The rule is the same (merge the
 * lowest-ranked adjacent pair, the leftmost on a tie, until no pair has a
 * rank), so the ids are identical; test/counters.test.ts checks that against
 * js-tiktoken itself.
 */

export interface O200kEncoder {
  /** Token ids of the text. Special-token strings are encoded as ordinary text. */
  encode(text: string): number[];
  count(text: string): number;
}

interface RankFile {
  pat_str: string;
  bpe_ranks: string;
}

/** Loads the 2 MB rank table; only call this when the mode is used. */
export async function loadO200k(): Promise<O200kEncoder> {
  const { default: ranks } = (await import('js-tiktoken/ranks/o200k_base')) as { default: RankFile };
  return createEncoder(ranks);
}

export function createEncoder(file: RankFile): O200kEncoder {
  // Keys are the token's bytes as a latin1 string: one char per byte, cheap to slice and hash.
  const ranks = new Map<string, number>();
  let longest = 0;
  // Each line: a label, the rank of its first token, then base64 tokens with consecutive ranks.
  for (const line of file.bpe_ranks.split('\n')) {
    if (line === '') continue;
    const [, offset = '0', ...tokens] = line.split(' ');
    const first = Number.parseInt(offset, 10);
    tokens.forEach((token, i) => {
      const bytes = Buffer.from(token, 'base64').toString('latin1');
      ranks.set(bytes, first + i);
      if (bytes.length > longest) longest = bytes.length;
    });
  }
  const pattern = new RegExp(file.pat_str, 'gu');

  const encode = (text: string): number[] => {
    const ids: number[] = [];
    for (const match of text.matchAll(pattern)) {
      const piece = Buffer.from(match[0], 'utf8').toString('latin1');
      const whole = ranks.get(piece);
      if (whole !== undefined) ids.push(whole);
      else for (const id of merge(piece, ranks, longest)) ids.push(id);
    }
    return ids;
  };
  return { encode, count: (text) => encode(text).length };
}

/**
 * Byte-pair merge in O(n log n). Parts are contiguous, so a part is named by
 * its start offset and the next part starts where it ends. The queue holds
 * (rank, start) for adjacent pairs; an entry whose pair has changed since it
 * was queued is skipped when it surfaces.
 */
function merge(piece: string, ranks: Map<string, number>, longest: number): number[] {
  const n = piece.length;
  const end = new Int32Array(n);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    end[i] = i + 1;
    prev[i] = i - 1;
  }
  const queue = new MinQueue();
  /** Rank of the part at `start` joined with the part after it, or undefined. */
  const pairRank = (start: number): number | undefined => {
    const middle = end[start] as number;
    if (middle >= n) return undefined;
    const stop = end[middle] as number;
    if (stop - start > longest) return undefined;
    return ranks.get(piece.slice(start, stop));
  };
  const enqueue = (start: number): void => {
    const rank = pairRank(start);
    // start < 2^32 and rank < 2^20, so the key is an exact integer, ordered by rank then start.
    if (rank !== undefined) queue.push(rank * 2 ** 32 + start);
  };
  for (let i = 0; i < n - 1; i++) enqueue(i);

  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    const rank = Math.floor(key / 2 ** 32);
    const start = key - rank * 2 ** 32;
    // A merged-away part has end -1. Otherwise the pair must still have this rank.
    if (end[start] === -1 || pairRank(start) !== rank) continue;
    const middle = end[start] as number;
    const stop = end[middle] as number;
    end[start] = stop;
    end[middle] = -1;
    if (stop < n) prev[stop] = start;
    enqueue(start);
    const before = prev[start] as number;
    if (before >= 0) enqueue(before);
  }

  const ids: number[] = [];
  for (let start = 0; start < n; start = end[start] as number) {
    const id = ranks.get(piece.slice(start, end[start]));
    // Every single byte has a rank in o200k_base, so this is always defined.
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** A binary min-heap of numbers. */
class MinQueue {
  readonly #heap: number[] = [];

  push(value: number): void {
    const heap = this.#heap;
    let i = heap.push(value) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((heap[parent] as number) <= value) break;
      heap[i] = heap[parent] as number;
      i = parent;
    }
    heap[i] = value;
  }

  pop(): number | undefined {
    const heap = this.#heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length === 0 || last === undefined) return top;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && (heap[right] as number) < (heap[left] as number) ? right : left;
      if ((heap[child] as number) >= last) break;
      heap[i] = heap[child] as number;
      i = child;
    }
    heap[i] = last;
    return top;
  }
}
