import { Client, type Implementation, type Prompt, type Resource, type Tool } from '@modelcontextprotocol/client';
import { FootprintError, TimeoutError } from './errors.js';
import { ProcessTransport } from './stdio.js';
import { VERSION } from './version.js';

export interface CollectOptions {
  command: string;
  args: readonly string[];
  /** Deadline for the whole session: spawn, initialize and every list call. */
  timeoutMs: number;
  graceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: (chunk: string) => void;
  /** Aborts the session early, for example on Ctrl-C. */
  signal?: AbortSignal;
}

export interface Collected {
  server: Implementation | null;
  tools: Tool[];
  /** How many tools/list pages the server returned. */
  toolPages: number;
  /** null when the server does not advertise the capability. */
  prompts: Prompt[] | null;
  resources: Resource[] | null;
}

/** Stops a server whose cursors never end; far above any real server. */
export const MAX_PAGES = 1000;

/** Starts a server over stdio, lists what it exposes, and stops it. */
export async function collectFromServer(options: CollectOptions): Promise<Collected> {
  const transport = new ProcessTransport({
    command: options.command,
    args: options.args,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.env !== undefined && { env: options.env }),
    ...(options.graceMs !== undefined && { graceMs: options.graceMs }),
    ...(options.onStderr !== undefined && { onStderr: options.onStderr }),
  });
  const session = new Session(transport, options.timeoutMs, options.signal);
  try {
    const client = new Client({ name: 'mcp-footprint', version: VERSION }, { capabilities: {} });
    // connect() starts the transport, then runs the initialize handshake.
    await session.step('initialize', () => client.connect(transport, session.requestOptions()));
    const capabilities = client.getServerCapabilities() ?? {};
    const tools = await session.step('tools/list', () =>
      paginate('tools/list', async (cursor) => {
        const page = await client.request({ method: 'tools/list', params: cursorParams(cursor) }, session.requestOptions());
        return { items: page.tools, nextCursor: page.nextCursor };
      }),
    );
    const prompts = capabilities.prompts
      ? await session.step('prompts/list', () =>
          paginate('prompts/list', async (cursor) => {
            const page = await client.request({ method: 'prompts/list', params: cursorParams(cursor) }, session.requestOptions());
            return { items: page.prompts, nextCursor: page.nextCursor };
          }),
        )
      : null;
    const resources = capabilities.resources
      ? await session.step('resources/list', () =>
          paginate('resources/list', async (cursor) => {
            const page = await client.request({ method: 'resources/list', params: cursorParams(cursor) }, session.requestOptions());
            return { items: page.resources, nextCursor: page.nextCursor };
          }),
        )
      : null;
    return {
      server: client.getServerVersion() ?? null,
      tools: tools.items,
      toolPages: tools.pages,
      prompts: prompts?.items ?? null,
      resources: resources?.items ?? null,
    };
  } finally {
    session.dispose();
    await transport.shutdown();
  }
}

interface Page<T> {
  items: T[];
  nextCursor?: string | undefined;
}

function cursorParams(cursor: string | undefined): { cursor?: string } {
  return cursor === undefined ? {} : { cursor };
}

/**
 * Follows nextCursor until the server stops sending one. An empty string is
 * treated as the end too: some servers send "" instead of omitting the field.
 * A cursor seen twice is an error rather than an infinite loop.
 */
export async function paginate<T>(
  method: string,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(cursor);
    pages += 1;
    items.push(...page.items);
    cursor = page.nextCursor === '' ? undefined : page.nextCursor;
    if (cursor === undefined) return { items, pages };
    if (seen.has(cursor)) {
      throw new FootprintError(`${method}: server sent nextCursor ${JSON.stringify(cursor)} twice; stopping`);
    }
    if (pages >= MAX_PAGES) throw new FootprintError(`${method}: more than ${MAX_PAGES} pages; stopping`);
    seen.add(cursor);
  }
}

/** One deadline shared by every step, plus fail-fast when the server exits. */
class Session {
  readonly #transport: ProcessTransport;
  readonly #deadline: number;
  readonly #timeoutMs: number;
  readonly #controller = new AbortController();
  readonly #timer: NodeJS.Timeout;
  readonly #onAbort: () => void;
  readonly #outer: AbortSignal | undefined;

  constructor(transport: ProcessTransport, timeoutMs: number, outer?: AbortSignal) {
    this.#transport = transport;
    this.#timeoutMs = timeoutMs;
    this.#deadline = Date.now() + timeoutMs;
    this.#timer = setTimeout(() => {
      this.#controller.abort(new TimeoutError(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    this.#outer = outer;
    this.#onAbort = () => {
      this.#controller.abort(new FootprintError('interrupted'));
    };
    outer?.addEventListener('abort', this.#onAbort, { once: true });
    if (outer?.aborted) this.#onAbort();
  }

  requestOptions(): { signal: AbortSignal; timeout: number } {
    return { signal: this.#controller.signal, timeout: Math.max(1, this.#deadline - Date.now()) };
  }

  /** Runs one step, failing with a message that names the step and why it failed. */
  async step<T>(name: string, run: () => Promise<T>): Promise<T> {
    const signal = this.#controller.signal;
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => {
        const reason = signal.reason as Error;
        reject(reason instanceof TimeoutError ? this.#timeout(name) : reason);
      };
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
    try {
      return await Promise.race([run(), aborted, this.#exitedEarly(name)]);
    } catch (error) {
      if (error instanceof FootprintError) throw error;
      throw this.#withStderr(new FootprintError(`${name} failed: ${(error as Error).message}`));
    }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#outer?.removeEventListener('abort', this.#onAbort);
  }

  #exitedEarly(step: string): Promise<never> {
    return this.#transport.exited.then(({ code, signal }) => {
      const how = signal ? `signal ${signal}` : `code ${String(code)}`;
      throw this.#withStderr(new FootprintError(`server exited (${how}) during ${step}`));
    });
  }

  #timeout(step: string): TimeoutError {
    return this.#withStderr(new TimeoutError(`timed out after ${this.#timeoutMs} ms waiting for ${step}`));
  }

  #withStderr<E extends Error>(error: E): E {
    const tail = this.#transport.stderrTail.trim();
    if (tail) error.message += `\nlast server stderr:\n${tail}`;
    return error;
  }
}
