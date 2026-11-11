import type { Counter, CounterInfo, ToolCounts } from './counters.js';
import { FootprintError } from './errors.js';
import type { ToolDefinition } from './serialize.js';

/** The model in the token-counting docs' examples; override with --model. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
/** The anthropic-version header value in the token-counting docs. */
export const ANTHROPIC_VERSION = '2026-10-21';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface AnthropicCounterOptions {
  apiKey: string;
  model?: string;
  version?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Parallel requests; the endpoint is free but rate limited. */
  concurrency?: number;
  /** Retries after a 429 or 5xx. */
  retries?: number;
  /** Wait before a retry when the response has no retry-after header. */
  retryDelayMs?: number;
}

type Message = { role: 'user'; content: string };

interface CountRequest {
  model: string;
  messages: Message[];
  tools?: readonly ToolDefinition[];
}

/** The smallest valid conversation; every count is taken relative to it. */
const PROBE: Message[] = [{ role: 'user', content: 'x' }];

/**
 * Counts with POST /v1/messages/count_tokens. The API returns a request's
 * whole input size, so tool cost is a difference:
 *
 *   total      = count(probe + all tools) - count(probe)
 *   tool i     = count(probe + all tools) - count(probe + all tools but i)
 *   overhead   = total - sum(tool i)
 *
 * The overhead is the tool-use preamble the API adds once when any tool is
 * present. With a single tool it cannot be separated and lands on that tool.
 * A server with n tools costs n + 2 requests.
 */
export class AnthropicCounter implements Counter {
  readonly info: CounterInfo;
  readonly #options: Required<Omit<AnthropicCounterOptions, 'fetch'>> & { fetch: typeof fetch };

  constructor(options: AnthropicCounterOptions) {
    this.#options = {
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_ANTHROPIC_MODEL,
      version: options.version ?? ANTHROPIC_VERSION,
      baseUrl: (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, ''),
      fetch: options.fetch ?? fetch,
      concurrency: options.concurrency ?? 4,
      retries: options.retries ?? 2,
      retryDelayMs: options.retryDelayMs ?? 1000,
    };
    this.info = {
      mode: 'anthropic',
      unit: 'Claude tokens',
      label: `Anthropic count_tokens API, model ${this.#options.model}: request with the tools minus request without`,
      exact: true,
      model: this.#options.model,
    };
  }

  async countTools(definitions: readonly ToolDefinition[]): Promise<ToolCounts> {
    if (definitions.length === 0) return { perTool: [], total: 0, overhead: 0 };
    const requests: CountRequest[] = [
      this.#request(),
      this.#request(definitions),
      ...definitions.map((_, i) => this.#request(definitions.filter((__, j) => j !== i))),
    ];
    const [base = 0, all = 0, ...without] = await this.#pool(requests);
    const total = all - base;
    const perTool = definitions.length === 1 ? [total] : without.map((count) => all - count);
    return { perTool, total, overhead: total - perTool.reduce((a, b) => a + b, 0) };
  }

  /** Tokens a block of text adds as message content, relative to the probe. */
  async countText(text: string): Promise<number> {
    const [base = 0, withText = 0] = await this.#pool([
      this.#request(),
      { ...this.#request(), messages: [{ role: 'user', content: text }] },
    ]);
    return withText - base;
  }

  #request(tools?: readonly ToolDefinition[]): CountRequest {
    return { model: this.#options.model, messages: PROBE, ...(tools && tools.length > 0 && { tools }) };
  }

  async #pool(requests: CountRequest[]): Promise<number[]> {
    const results = new Array<number>(requests.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < requests.length) {
        const index = next++;
        results[index] = await this.#count(requests[index] as CountRequest);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#options.concurrency, requests.length) }, worker));
    return results;
  }

  async #count(body: CountRequest): Promise<number> {
    const { apiKey, version, baseUrl, retries, retryDelayMs } = this.#options;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#options.fetch(`${baseUrl}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': version, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new FootprintError(`Anthropic count_tokens request failed: ${(error as Error).message}`);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < retries) {
        await response.body?.cancel();
        const after = Number(response.headers.get('retry-after'));
        await new Promise((resolve) => setTimeout(resolve, after > 0 ? after * 1000 : retryDelayMs));
        continue;
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        const message = (parsed as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 200);
        throw new FootprintError(`Anthropic count_tokens returned HTTP ${response.status}: ${message}`);
      }
      const tokens = (parsed as { input_tokens?: unknown } | undefined)?.input_tokens;
      if (typeof tokens !== 'number' || !Number.isInteger(tokens)) {
        throw new FootprintError(`Anthropic count_tokens returned no input_tokens: ${text.slice(0, 200)}`);
      }
      return tokens;
    }
  }
}
