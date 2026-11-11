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
  /** Wait before a retry when the response has no usable retry-after header. */
  retryDelayMs?: number;
  /** Longest wait before a retry, whatever retry-after says. */
  maxRetryDelayMs?: number;
  /** Deadline for each HTTP request. */
  timeoutMs?: number;
  /** Aborts requests and retry waits early, for example on Ctrl-C. */
  signal?: AbortSignal;
  /** Allow a plain http: base URL that is not loopback. Off by default: the key would travel in clear text. */
  allowInsecureBaseUrl?: boolean;
}

/** A server-chosen retry-after must not park the CLI for minutes. */
export const MAX_RETRY_DELAY_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

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
  readonly #options: Required<Omit<AnthropicCounterOptions, 'fetch' | 'signal' | 'baseUrl' | 'allowInsecureBaseUrl'>> & {
    fetch: typeof fetch;
    signal: AbortSignal | undefined;
  };
  readonly #endpoint: URL;

  constructor(options: AnthropicCounterOptions) {
    this.#endpoint = endpointFor(options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL, options.allowInsecureBaseUrl === true);
    this.#options = {
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_ANTHROPIC_MODEL,
      version: options.version ?? ANTHROPIC_VERSION,
      fetch: options.fetch ?? fetch,
      concurrency: options.concurrency ?? 4,
      retries: options.retries ?? 2,
      retryDelayMs: options.retryDelayMs ?? 1000,
      maxRetryDelayMs: options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      signal: options.signal,
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
    const { apiKey, version, retries, retryDelayMs, maxRetryDelayMs, timeoutMs, signal } = this.#options;
    for (let attempt = 0; ; attempt++) {
      throwIfInterrupted(signal);
      const deadline = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await this.#options.fetch(this.#endpoint.href, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': version, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // Never follow a redirect: fetch would replay x-api-key to the new origin.
          redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
      } catch (error) {
        throwIfInterrupted(signal);
        if (deadline.aborted) throw new FootprintError(`Anthropic count_tokens timed out after ${timeoutMs} ms`);
        throw new FootprintError(`Anthropic count_tokens request failed: ${(error as Error).message}`);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new FootprintError(
          `Anthropic count_tokens answered with a redirect (HTTP ${response.status}); not following it, the API key would be sent to another host. Check ANTHROPIC_BASE_URL.`,
        );
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < retries) {
        await response.body?.cancel();
        await sleep(retryDelay(response.headers.get('retry-after'), retryDelayMs, maxRetryDelayMs), signal);
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

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates the base URL once and returns the count_tokens endpoint under it.
 * The API key goes in a header, so the URL must be https (http only for
 * loopback, which the tests and local proxies use) and must not carry
 * credentials of its own. A path prefix is kept; query and fragment are not.
 */
function endpointFor(baseUrl: string, allowInsecure: boolean): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new FootprintError(`ANTHROPIC_BASE_URL is not a valid URL: ${JSON.stringify(baseUrl.slice(0, 100))}`);
  }
  if (base.username !== '' || base.password !== '') {
    throw new FootprintError('the Anthropic base URL must not contain credentials; the key is sent in the x-api-key header');
  }
  const secure = base.protocol === 'https:';
  const loopback = base.protocol === 'http:' && LOOPBACK.has(base.hostname);
  if (!secure && !loopback && !(allowInsecure && base.protocol === 'http:')) {
    throw new FootprintError(`the Anthropic base URL must use https: (http: is allowed only for localhost), not ${base.protocol}`);
  }
  return new URL(`${trimTrailingSlashes(base.pathname)}/v1/messages/count_tokens`, base.origin);
}

/** retry-after is delay-seconds or an HTTP date; anything else, or a non-positive value, uses the fallback. */
function retryDelay(header: string | null, fallbackMs: number, maxMs: number): number {
  let ms = fallbackMs;
  if (header !== null && header.trim() !== '') {
    const seconds = Number(header);
    const date = Date.parse(header);
    if (Number.isFinite(seconds) && seconds > 0) ms = seconds * 1000;
    else if (Number.isNaN(seconds) && Number.isFinite(date) && date > Date.now()) ms = date - Date.now();
  }
  return Math.min(Math.max(ms, 0), maxMs);
}

function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FootprintError('interrupted');
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new FootprintError('interrupted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Without a regex: /\/+$/ backtracks quadratically on a long run of slashes. */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
