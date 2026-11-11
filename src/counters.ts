import { Worker } from 'node:worker_threads';
import type { CountReply, CountRequest } from './count-worker.js';
import { FootprintError, TimeoutError } from './errors.js';
import { loadO200k } from './o200k.js';
import { serialize, type ToolDefinition } from './serialize.js';

export type CountMode = 'o200k' | 'anthropic' | 'chars4';

export interface CounterInfo {
  mode: CountMode;
  /** Short name for column headers, e.g. "o200k tokens". */
  unit: string;
  /** One line that says exactly what the number is. */
  label: string;
  /** False for estimates. Estimates are never printed without their label. */
  exact: boolean;
  model?: string;
}

export interface ToolCounts {
  /** One count per definition, in input order. */
  perTool: number[];
  total: number;
  /**
   * Tokens in the total that belong to no single tool. Zero for the local
   * counters; in anthropic mode, the tool-use preamble the API adds.
   */
  overhead: number;
}

export interface Counter {
  readonly info: CounterInfo;
  countTools(definitions: readonly ToolDefinition[]): Promise<ToolCounts>;
  countText(text: string): Promise<number>;
  /** Releases what the counter holds (a worker thread). Optional. */
  close?(): Promise<void>;
}

/** Counts each definition separately; the total is the sum. */
abstract class LocalCounter implements Counter {
  abstract readonly info: CounterInfo;
  protected abstract count(text: string): number;

  countTools(definitions: readonly ToolDefinition[]): Promise<ToolCounts> {
    const perTool = definitions.map((definition) => this.count(serialize(definition)));
    return Promise.resolve({ perTool, total: perTool.reduce((a, b) => a + b, 0), overhead: 0 });
  }

  countText(text: string): Promise<number> {
    return Promise.resolve(this.count(text));
  }
}

/** What the o200k label says the number is, and is not. */
export const O200K_LABEL = "o200k_base: exact token count of each tool's JSON definition";

/** Counts a batch of texts, one number per text. */
type CountBatch = (texts: string[]) => Promise<number[]>;

export interface WorkerOptions {
  /** Epoch ms after which counting is abandoned and the worker terminated. */
  deadline: number;
  /** The --timeout value, for the error message. */
  timeoutMs: number;
}

export class O200kCounter implements Counter {
  readonly info: CounterInfo = {
    mode: 'o200k',
    unit: 'o200k tokens',
    label: O200K_LABEL,
    exact: true,
  };

  readonly #batch: CountBatch;
  readonly #close: () => Promise<void>;

  private constructor(batch: CountBatch, close: () => Promise<void> = () => Promise.resolve()) {
    this.#batch = batch;
    this.#close = close;
  }

  /** Counts on this thread. Loads the 2 MB rank table only when this mode is used. */
  static async load(): Promise<O200kCounter> {
    const encoder = await loadO200k();
    return new O200kCounter((texts) => Promise.resolve(texts.map((text) => encoder.count(text))));
  }

  /**
   * Counts in a worker thread that is terminated at the deadline, so no input
   * can hold the CLI past --timeout. The worker starts loading the rank table
   * at once, while the server is still starting.
   */
  static inWorker(options: WorkerOptions): O200kCounter {
    const pool = new CountWorker(options);
    return new O200kCounter(
      (texts) => pool.count(texts),
      () => pool.close(),
    );
  }

  async countTools(definitions: readonly ToolDefinition[]): Promise<ToolCounts> {
    const perTool = await this.#batch(definitions.map(serialize));
    return { perTool, total: perTool.reduce((a, b) => a + b, 0), overhead: 0 };
  }

  async countText(text: string): Promise<number> {
    const [count = 0] = await this.#batch([text]);
    return count;
  }

  close(): Promise<void> {
    return this.#close();
  }
}

/** One worker thread, many requests, one deadline. */
class CountWorker {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (counts: number[]) => void; reject: (error: Error) => void }>();
  readonly #timer: NodeJS.Timeout;
  readonly #timeoutMs: number;
  #nextId = 0;
  #failure: Error | undefined;

  constructor({ deadline, timeoutMs }: WorkerOptions) {
    this.#timeoutMs = timeoutMs;
    this.#worker = new Worker(new URL('./count-worker.js', import.meta.url));
    this.#worker.on('message', ({ id, counts }: CountReply) => {
      this.#pending.get(id)?.resolve(counts);
      this.#pending.delete(id);
    });
    this.#worker.on('error', (error) => {
      this.#fail(new FootprintError(`token counting failed: ${error.message}`));
    });
    this.#worker.on('exit', () => {
      this.#fail(new FootprintError('token counting stopped unexpectedly'));
    });
    this.#timer = setTimeout(() => {
      this.#fail(new TimeoutError(`timed out after ${this.#timeoutMs} ms counting tokens`));
    }, Math.max(0, deadline - Date.now()));
    // An idle worker or a pending deadline must not keep the process alive on its own.
    this.#worker.unref();
    this.#timer.unref();
  }

  count(texts: string[]): Promise<number[]> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // Hold the process open while a count is outstanding.
      this.#timer.ref();
      this.#worker.ref();
      this.#worker.postMessage({ id, texts } satisfies CountRequest);
    }).finally(() => {
      if (this.#pending.size === 0) {
        this.#timer.unref();
        this.#worker.unref();
      }
    }) as Promise<number[]>;
  }

  async close(): Promise<void> {
    this.#fail(new FootprintError('the token counter is closed'));
    await this.#worker.terminate();
  }

  /** The first failure wins: it rejects everything pending and every later request. */
  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    clearTimeout(this.#timer);
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    void this.#worker.terminate();
  }
}

export class Chars4Counter extends LocalCounter {
  readonly info: CounterInfo = {
    mode: 'chars4',
    unit: 'est. tokens (chars/4)',
    label: 'chars/4: an estimate, not a tokenizer (UTF-16 length of the JSON / 4, rounded up)',
    exact: false,
  };

  protected count(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
