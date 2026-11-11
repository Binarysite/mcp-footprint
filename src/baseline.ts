import { readFile } from 'node:fs/promises';
import { FootprintError } from './errors.js';
import type { Report } from './measure.js';

export interface ToolDelta {
  name: string;
  before: number;
  after: number;
  delta: number;
}

/** How this run differs from an earlier report, size-limit style. */
export interface BaselineDiff {
  /** The --baseline path as given. */
  path: string;
  before: number;
  after: number;
  delta: number;
  /** delta / before, rounded to 4 decimals; null when the baseline total is 0. */
  percent: number | null;
  /** Tools in both, with a different count; biggest change first. */
  changed: ToolDelta[];
  added: { name: string; tokens: number }[];
  removed: { name: string; tokens: number }[];
}

/** What the diff reads from a baseline file. */
type BaselineReport = Pick<Report, 'counter' | 'total' | 'tools'>;

/**
 * Reads an earlier report: the output of --json or --out, or a committed
 * reference report (which wraps one under "report").
 */
export async function loadBaseline(path: string): Promise<BaselineReport> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new FootprintError(`cannot read baseline ${path}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new FootprintError(`baseline ${path} is not valid JSON: ${(error as Error).message}`);
  }
  const candidate = isObject(data) && isObject(data.report) ? data.report : data;
  if (!isReport(candidate)) {
    throw new FootprintError(`baseline ${path} is not an mcp-footprint report (write one with --json or --out)`);
  }
  return candidate;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isReport(value: unknown): value is BaselineReport {
  if (!isObject(value) || !isObject(value.counter) || !isObject(value.total) || !Array.isArray(value.tools)) return false;
  if (typeof value.counter.mode !== 'string' || typeof value.total.tokens !== 'number') return false;
  return value.tools.every((tool: unknown) => isObject(tool) && typeof tool.name === 'string' && typeof tool.tokens === 'number');
}

export function diffBaseline(baseline: BaselineReport, current: BaselineReport, path: string): BaselineDiff {
  if (baseline.counter.mode !== current.counter.mode) {
    throw new FootprintError(
      `baseline ${path} was counted with ${baseline.counter.mode}, this run with ${current.counter.mode}; compare like with like (use --count ${baseline.counter.mode})`,
    );
  }
  // Tools are paired by name and by position among the tools of that name, so
  // two tools that share a name are compared one to one instead of collapsing.
  const keyed = (tools: BaselineReport['tools']): Map<string, { name: string; tokens: number }> => {
    const seen = new Map<string, number>();
    const map = new Map<string, { name: string; tokens: number }>();
    for (const tool of tools) {
      const index = seen.get(tool.name) ?? 0;
      seen.set(tool.name, index + 1);
      map.set(`${index}\u0000${tool.name}`, { name: tool.name, tokens: tool.tokens });
    }
    return map;
  };
  const before = keyed(baseline.tools);
  const after = keyed(current.tools);
  const changed: ToolDelta[] = [];
  const added: { name: string; tokens: number }[] = [];
  for (const [key, now] of after) {
    const old = before.get(key);
    if (old === undefined) added.push({ name: now.name, tokens: now.tokens });
    else if (old.tokens !== now.tokens) {
      changed.push({ name: now.name, before: old.tokens, after: now.tokens, delta: now.tokens - old.tokens });
    }
  }
  const removed = [...before].filter(([key]) => !after.has(key)).map(([, old]) => ({ name: old.name, tokens: old.tokens }));
  const delta = current.total.tokens - baseline.total.tokens;
  const bySize = (a: { name: string }, b: { name: string }, x: number, y: number): number =>
    y - x || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    path,
    before: baseline.total.tokens,
    after: current.total.tokens,
    delta,
    percent: baseline.total.tokens > 0 ? Math.round((delta / baseline.total.tokens) * 10_000) / 10_000 : null,
    changed: changed.sort((a, b) => bySize(a, b, Math.abs(a.delta), Math.abs(b.delta))),
    added: added.sort((a, b) => bySize(a, b, a.tokens, b.tokens)),
    removed: removed.sort((a, b) => bySize(a, b, a.tokens, b.tokens)),
  };
}

const fmt = new Intl.NumberFormat('en-US');
const signed = (value: number): string => `${value > 0 ? '+' : value < 0 ? '-' : ''}${fmt.format(Math.abs(value))}`;
const SHOWN = 3;

/** The total change, then the details, as separate parts. */
export function deltaParts(diff: BaselineDiff): { total: string; details: string[] } {
  if (diff.delta === 0 && diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
    return { total: 'no change (0 tokens)', details: [] };
  }
  let total = `${signed(diff.delta)} tokens`;
  if (diff.percent !== null && diff.delta !== 0) {
    const pct = diff.percent * 100;
    // One decimal below 10%, so a small change does not print as 0%.
    total += ` (${pct > 0 ? '+' : '-'}${Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.round(Math.abs(pct)).toString()}%)`;
  }
  const details: string[] = [];
  if (diff.changed.length > 0) {
    const shown = diff.changed.slice(0, SHOWN).map((t) => `${t.name} ${signed(t.delta)}`);
    const rest = diff.changed.length - SHOWN;
    details.push(rest > 0 ? `${shown.join(', ')} and ${rest} more tool${rest === 1 ? '' : 's'} changed` : shown.join(', '));
  }
  if (diff.added.length > 0) details.push(`${diff.added.length} tool${diff.added.length === 1 ? '' : 's'} added`);
  if (diff.removed.length > 0) details.push(`${diff.removed.length} tool${diff.removed.length === 1 ? '' : 's'} removed`);
  return { total, details };
}

/** One line: "+312 tokens (+11%); search_issues +280; 2 tools added". */
export function formatDelta(diff: BaselineDiff): string {
  const { total, details } = deltaParts(diff);
  return [total, ...details].join('; ');
}
