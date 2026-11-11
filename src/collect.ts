import { Client, type Implementation, type Tool } from '@modelcontextprotocol/client';
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
}

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
    const result = await session.step('tools/list', () =>
      client.request({ method: 'tools/list', params: {} }, session.requestOptions()),
    );
    return { server: client.getServerVersion() ?? null, tools: result.tools };
  } finally {
    session.dispose();
    await transport.shutdown();
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
