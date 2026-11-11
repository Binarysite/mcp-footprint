import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { deserializeMessage, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { FootprintError } from './errors.js';

export interface ProcessTransportOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait after closing stdin, and again after SIGTERM, before escalating. */
  graceMs?: number;
  /** Called with every chunk the server writes to stderr. */
  onStderr?: (chunk: string) => void;
  /**
   * Most bytes the server may write without ending a message (a newline).
   * Past it the transport reports an error and stops the server.
   */
  maxMessageBytes?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const STDERR_TAIL_BYTES = 4096;
/** Far above any real tools/list page, far below what fills a CI runner's memory. */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Grace per shutdown step once the run has already failed (timeout, Ctrl-C, flood). */
export const FAILURE_GRACE_MS = 200;
const isWindows = process.platform === 'win32';

/**
 * An MCP stdio transport that owns the server's whole process group.
 *
 * The SDK's StdioClientTransport spawns the server itself and kills only the
 * direct child. Servers launched through `npx`, `sh -c` or `uv run` are
 * wrappers around a grandchild, so killing the child can leave the real
 * server running. This transport starts the server as the leader of a new
 * process group and signals the group on shutdown.
 */
export class ProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #options: ProcessTransportOptions;
  /** Chunks of the line not yet ended by a newline, and their total size. */
  #partial: Buffer[] = [];
  #partialBytes = 0;
  #fatal: FootprintError | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #exit: ExitInfo | undefined;
  readonly #exited: Promise<ExitInfo>;
  #resolveExited: (info: ExitInfo) => void = () => undefined;
  #stderrTail = '';
  #closing: Promise<void> | undefined;

  constructor(options: ProcessTransportOptions) {
    this.#options = options;
    this.#exited = new Promise((resolve) => {
      this.#resolveExited = resolve;
    });
  }

  /** The last few KB the server wrote to stderr, for error messages. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** Set when the transport stopped the server itself, for example after a flood of output. */
  get fatalError(): FootprintError | undefined {
    return this.#fatal;
  }

  /** Resolves when the server process exits. Stays pending if it never started. */
  get exited(): Promise<ExitInfo> {
    return this.#exited;
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error('transport already started');
    const { command, args, cwd, env } = this.#options;
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: true,
    });
    this.#child = child;
    child.once('exit', (code, signal) => {
      this.#exit = { code, signal };
      this.#resolveExited(this.#exit);
      this.onclose?.();
    });

    child.stdout.on('data', (chunk: Buffer) => {
      this.#read(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      this.#options.onStderr?.(chunk);
    });
    // EPIPE when the server exits while we write; the exit handler reports it.
    child.stdin.on('error', () => undefined);

    try {
      await Promise.race([
        once(child, 'spawn'),
        once(child, 'error').then(([error]) => {
          throw error;
        }),
      ]);
    } catch (error) {
      // No process exists: shutdown() has nothing to stop, and `exited` stays pending.
      this.#child = undefined;
      throw new FootprintError(`could not start ${command}: ${(error as Error).message}`);
    }
    child.on('error', (error) => this.onerror?.(error));
  }

  /**
   * Splits stdout into lines without copying the unfinished one on every
   * chunk, and stops the server once an unfinished line passes the cap.
   */
  #read(chunk: Buffer): void {
    if (this.#fatal) return;
    let from = 0;
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, from)) {
      const piece = chunk.subarray(from, newline);
      const line = this.#partial.length === 0 ? piece : Buffer.concat([...this.#partial, piece]);
      this.#partial = [];
      this.#partialBytes = 0;
      from = newline + 1;
      this.#deliver(line.toString('utf8').replace(/\r$/, ''));
    }
    if (from < chunk.length) {
      this.#partial.push(chunk.subarray(from));
      this.#partialBytes += chunk.length - from;
    }
    const max = this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (this.#partialBytes > max) {
      this.#partial = [];
      this.#partialBytes = 0;
      this.#fatal = new FootprintError(`server wrote more than ${formatBytes(max)} without ending a message; stopping it`);
      this.#child?.stdout.pause();
      this.onerror?.(this.#fatal);
      void this.shutdown(FAILURE_GRACE_MS);
    }
  }

  /** Lines that are not JSON are logs and skipped; JSON that is not JSON-RPC is reported. */
  #deliver(line: string): void {
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      this.onerror?.(new FootprintError(`unreadable output from server: ${(error as Error).message}`));
      return;
    }
    this.onmessage?.(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#child?.stdin;
    if (stdin === undefined || this.#exit) throw new FootprintError('server is not running');
    if (!stdin.write(serializeMessage(message))) await once(stdin, 'drain');
  }

  /** Same as shutdown(); the SDK calls this from Client.close(). */
  close(): Promise<void> {
    return this.shutdown();
  }

  /**
   * Stops the server the way the MCP stdio spec describes: close stdin, wait,
   * SIGTERM, wait, SIGKILL. Signals go to the whole process group, and the
   * group is swept with SIGKILL at the end even if the leader exited on its
   * own, so no grandchild outlives the measurement. `graceMs` overrides the
   * configured wait per step; the first call decides it.
   */
  shutdown(graceMs?: number): Promise<void> {
    this.#closing ??= this.#shutdown(graceMs ?? this.#options.graceMs ?? 2000);
    return this.#closing;
  }

  async #shutdown(graceMs: number): Promise<void> {
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    if (!this.#exit && !(await this.#waitForExit(graceMs))) {
      this.#signal('SIGTERM');
      if (!(await this.#waitForExit(graceMs))) {
        this.#signal('SIGKILL');
        await this.#exited;
      }
    }
    this.#signal('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
  }

  async #waitForExit(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(resolve, ms, false);
    });
    const exited = await Promise.race([this.exited.then(() => true), timeout]);
    clearTimeout(timer);
    return exited;
  }

  #signal(signal: NodeJS.Signals): void {
    const child = this.#child;
    if (child?.pid === undefined) return;
    if (isWindows) {
      // No process groups on Windows; this reaches the direct child only.
      if (!this.#exit) child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      // ESRCH: the group is already empty. EPERM: macOS says this when every
      // member is a zombie awaiting reaping; there is nothing left to signal.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  }
}

function formatBytes(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${bytes} bytes`;
}
