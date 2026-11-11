// Counts o200k tokens off the main thread, so the CLI can stop a count that
// runs past its deadline by terminating this worker.
import { parentPort } from 'node:worker_threads';
import { loadO200k } from './o200k.js';

export interface CountRequest {
  id: number;
  texts: string[];
}

export interface CountReply {
  id: number;
  counts: number[];
}

const encoder = await loadO200k();
parentPort?.on('message', ({ id, texts }: CountRequest) => {
  parentPort?.postMessage({ id, counts: texts.map((text) => encoder.count(text)) } satisfies CountReply);
});
