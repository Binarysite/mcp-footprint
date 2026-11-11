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

export interface Encoder {
  encode(text: string, allowedSpecial?: string[] | 'all', disallowedSpecial?: string[] | 'all'): number[];
}

export class O200kCounter extends LocalCounter {
  readonly info: CounterInfo = {
    mode: 'o200k',
    unit: 'o200k tokens',
    label: "o200k_base: exact token count of each tool's JSON definition",
    exact: true,
  };

  readonly #encoder: Encoder;

  constructor(encoder: Encoder) {
    super();
    this.#encoder = encoder;
  }

  /** Loads the 2 MB rank table only when this mode is used. */
  static async load(): Promise<O200kCounter> {
    const [{ Tiktoken }, { default: ranks }] = await Promise.all([
      import('js-tiktoken/lite'),
      import('js-tiktoken/ranks/o200k_base'),
    ]);
    return new O200kCounter(new Tiktoken(ranks));
  }

  protected count(text: string): number {
    // Special-token strings such as <|endoftext|> in a description are
    // counted as ordinary text instead of throwing.
    return this.#encoder.encode(text, [], []).length;
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
