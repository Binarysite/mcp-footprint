import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
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
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const STDERR_TAIL_BYTES = 4096;
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
  readonly #readBuffer = new ReadBuffer();
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

  get exitInfo(): ExitInfo | undefined {
    return this.#exit;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Resolves when the server process exits. Never resolves if it never started. */
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
      try {
        this.#readBuffer.append(chunk);
      } catch (error) {
        this.onerror?.(new FootprintError(`unreadable output from server: ${(error as Error).message}`));
        return;
      }
      // ReadBuffer skips lines that are not JSON. A line that is JSON but not
      // JSON-RPC throws after it has been consumed, so the loop can go on.
      for (;;) {
        try {
          const message = this.#readBuffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        } catch (error) {
          this.onerror?.(new FootprintError(`unreadable output from server: ${(error as Error).message}`));
        }
      }
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
      throw new FootprintError(`could not start ${command}: ${(error as Error).message}`);
    }
    child.on('error', (error) => this.onerror?.(error));
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
   * own, so no grandchild outlives the measurement.
   */
  shutdown(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const graceMs = this.#options.graceMs ?? 2000;
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
      // ESRCH: the group is already empty.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
