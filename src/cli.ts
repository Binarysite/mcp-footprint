import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { AnthropicCounter, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { collectFromServer } from './collect.js';
import { Chars4Counter, O200kCounter, type CountMode, type Counter } from './counters.js';
import { FootprintError, UsageError } from './errors.js';
import { loadTools } from './load.js';
import { measure, withBudget, type MeasureInput } from './measure.js';
import { renderJson, renderText, sanitizeMessage } from './render.js';
import { VERSION } from './version.js';

export const EXIT = { ok: 0, overBudget: 1, error: 2, interrupted: 130 } as const;

export const USAGE = `Usage:
  mcp-footprint [options] -- <command> [args...]
  mcp-footprint [options] --from-json <file>

Starts an MCP server over stdio (or reads a saved tools/list result) and
reports how many tokens its tool definitions cost.

Options:
  --count <mode>       o200k (default), anthropic, or chars4
  --budget <tokens>    exit 1 when the total is above this
  --json               print the report as JSON
  --out <file>         also write the JSON report to a file
  --save-tools <file>  write the server's tools/list result to a file
  --timeout <ms>       deadline for the whole server session, and for each
                       API request with --count anthropic (default 30000)
  --model <id>         model for --count anthropic (default ${DEFAULT_ANTHROPIC_MODEL})
  --verbose            pass the server's stderr through
  -h, --help           show this help
  -v, --version        show the version

--count anthropic calls POST /v1/messages/count_tokens and needs
ANTHROPIC_API_KEY. ANTHROPIC_BASE_URL overrides the API host.

Exit codes: 0 ok, 1 over budget, 2 usage, server or API error, 130 interrupted.
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Aborted on Ctrl-C. */
  signal?: AbortSignal;
  /** Grace period for each shutdown step; tests shorten it. */
  graceMs?: number;
}

interface Options {
  count: CountMode;
  budget?: number;
  json: boolean;
  out?: string;
  saveTools?: string;
  timeoutMs: number;
  model: string;
  verbose: boolean;
  fromJson?: string;
  command: string[];
}

type Parsed = { kind: 'help' } | { kind: 'version' } | { kind: 'run'; options: Options };

const MODES: Record<string, CountMode> = { o200k: 'o200k', anthropic: 'anthropic', chars4: 'chars4', 'chars/4': 'chars4' };

export function parseCli(argv: readonly string[]): Parsed {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  let values;
  try {
    ({ values } = parseArgs({
      args: [...own],
      strict: true,
      allowPositionals: false,
      options: {
        count: { type: 'string', default: 'o200k' },
        budget: { type: 'string' },
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        'save-tools': { type: 'string' },
        timeout: { type: 'string', default: '30000' },
        model: { type: 'string', default: DEFAULT_ANTHROPIC_MODEL },
        verbose: { type: 'boolean', default: false },
        'from-json': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    }));
  } catch (error) {
    const message = (error as Error).message;
    throw new UsageError(/positional/i.test(message) ? 'put the server command after --' : message);
  }
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const count = MODES[values.count];
  if (!count) throw new UsageError(`--count must be o200k, anthropic or chars4, not "${values.count}"`);
  const fromJson = values['from-json'];
  if (fromJson !== undefined && command.length > 0) throw new UsageError('use either --from-json or -- <command>, not both');
  if (fromJson === undefined && command.length === 0) throw new UsageError('nothing to measure: give -- <command> or --from-json <file>');
  if (fromJson !== undefined && values['save-tools'] !== undefined) throw new UsageError('--save-tools needs a server, not --from-json');

  return {
    kind: 'run',
    options: {
      count,
      json: values.json,
      timeoutMs: positiveInteger(values.timeout, '--timeout'),
      model: values.model,
      verbose: values.verbose,
      command,
      ...(values.budget !== undefined && { budget: nonNegativeInteger(values.budget, '--budget') }),
      ...(values.out !== undefined && { out: values.out }),
      ...(values['save-tools'] !== undefined && { saveTools: values['save-tools'] }),
      ...(fromJson !== undefined && { fromJson }),
    },
  };
}

function nonNegativeInteger(text: string, flag: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) throw new UsageError(`${flag} must be a whole number, not "${text}"`);
  return value;
}

function positiveInteger(text: string, flag: string): number {
  const value = nonNegativeInteger(text, flag);
  if (value === 0) throw new UsageError(`${flag} must be greater than 0`);
  return value;
}

async function createCounter(options: Options, io: Io): Promise<Counter> {
  switch (options.count) {
    case 'o200k':
      return O200kCounter.load();
    case 'chars4':
      return new Chars4Counter();
    case 'anthropic': {
      const apiKey = io.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new FootprintError('--count anthropic needs ANTHROPIC_API_KEY');
      const baseUrl = io.env.ANTHROPIC_BASE_URL;
      return new AnthropicCounter({
        apiKey,
        model: options.model,
        ...(baseUrl && { baseUrl }),
        timeoutMs: options.timeoutMs,
        ...(io.signal && { signal: io.signal }),
        ...(io.fetch && { fetch: io.fetch }),
      });
    }
  }
}

async function gather(options: Options, io: Io): Promise<MeasureInput> {
  if (options.fromJson !== undefined) {
    return {
      source: { kind: 'file', path: options.fromJson },
      server: null,
      tools: await loadTools(options.fromJson),
      pages: null,
      prompts: null,
      resources: null,
    };
  }
  const [command = '', ...args] = options.command;
  const collected = await collectFromServer({
    command,
    args,
    timeoutMs: options.timeoutMs,
    env: io.env,
    ...(io.graceMs !== undefined && { graceMs: io.graceMs }),
    ...(io.signal && { signal: io.signal }),
    ...(options.verbose && { onStderr: io.stderr }),
  });
  if (options.saveTools !== undefined) {
    await writeFile(options.saveTools, `${JSON.stringify({ tools: collected.tools }, null, 2)}\n`);
  }
  return {
    source: { kind: 'stdio', command: options.command },
    server: collected.server ? { name: collected.server.name, version: collected.server.version } : null,
    tools: collected.tools,
    pages: collected.toolPages,
    prompts: collected.prompts,
    resources: collected.resources,
  };
}

/** Runs the CLI and returns the exit code. Never throws. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  try {
    const parsed = parseCli(argv);
    if (parsed.kind === 'help') {
      io.stdout(USAGE);
      return EXIT.ok;
    }
    if (parsed.kind === 'version') {
      io.stdout(`${VERSION}\n`);
      return EXIT.ok;
    }
    const { options } = parsed;
    // Build the counter first, so a missing API key fails before the server starts.
    const counter = await createCounter(options, io);
    const report = withBudget(await measure(await gather(options, io), counter), options.budget);
    if (options.out !== undefined) await writeFile(options.out, renderJson(report));
    io.stdout(options.json ? renderJson(report) : renderText(report));
    return report.budget?.over ? EXIT.overBudget : EXIT.ok;
  } catch (error) {
    if (io.signal?.aborted) {
      io.stderr('mcp-footprint: interrupted\n');
      return EXIT.interrupted;
    }
    const message = error instanceof FootprintError ? error.message : `unexpected error: ${(error as Error).stack ?? String(error)}`;
    // The message can echo tool names, paths or server stderr: strip terminal control characters.
    io.stderr(`mcp-footprint: ${sanitizeMessage(message)}\n`);
    if (error instanceof UsageError) io.stderr('Run mcp-footprint --help for usage.\n');
    return EXIT.error;
  }
}
