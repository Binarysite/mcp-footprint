import type { Counter, CounterInfo } from './counters.js';
import { FootprintError } from './errors.js';
import { schemaShape, toToolDefinition, type McpToolLike } from './serialize.js';
import { VERSION } from './version.js';

export interface ToolMeasure {
  name: string;
  tokens: number;
  /** tokens / total, rounded to 4 decimals. */
  share: number;
  /** Length of the serialized definition. */
  chars: number;
  descriptionChars: number;
  schemaChars: number;
  schemaDepth: number;
  schemaProperties: number;
}

export interface ListMeasure {
  count: number;
  tokens: number;
}

export type Source = { kind: 'stdio'; command: string[] } | { kind: 'file'; path: string };

export interface Ranked {
  name: string;
  value: number;
}

export interface Report {
  tool: 'mcp-footprint';
  version: string;
  source: Source;
  server: { name: string; version: string } | null;
  counter: CounterInfo;
  total: { tools: number; tokens: number; chars: number; pages: number | null };
  /** Part of total.tokens that belongs to no single tool (anthropic mode). */
  overhead: number;
  /** Most expensive first. */
  tools: ToolMeasure[];
  offenders: { longestDescriptions: Ranked[]; deepestSchemas: Ranked[]; biggestSchemas: Ranked[] };
  /** Listed by the server but not part of total: they are not sent with every request. */
  prompts: ListMeasure | null;
  resources: ListMeasure | null;
  budget: { limit: number; over: boolean } | null;
  /** Problems worth fixing that do not stop the measurement. */
  warnings: string[];
}

export interface MeasureInput {
  source: Source;
  server: { name: string; version: string } | null;
  tools: readonly McpToolLike[];
  pages: number | null;
  prompts: readonly Record<string, unknown>[] | null;
  resources: readonly Record<string, unknown>[] | null;
}

const OFFENDERS = 3;
const fmt = new Intl.NumberFormat('en-US');

/**
 * Largest tool definition accepted, in UTF-8 bytes of its JSON. Real tools
 * are a few KB, and test/reports.test.ts checks that every measured reference
 * tool fits.
 * The cap keeps one hostile definition from costing minutes of counting or a
 * huge API request.
 */
export const MAX_TOOL_BYTES = 64 * 1024;

export async function measure(input: MeasureInput, counter: Counter): Promise<Report> {
  const definitions = input.tools.map(toToolDefinition);
  // Fail with a clear error before any counter (or API request) sees a schema
  // too deep to serialize or a definition too big to count.
  for (const definition of definitions) {
    const bytes = Buffer.byteLength(stringify(definition, definition.name));
    if (bytes > MAX_TOOL_BYTES) {
      throw new FootprintError(
        `tool "${definition.name}" is ${fmt.format(bytes)} bytes as JSON; the limit is ${fmt.format(MAX_TOOL_BYTES)}. Real tool definitions are a few KB, and one this size could stall the count.`,
      );
    }
  }
  const counts = await counter.countTools(definitions);
  const total = counts.total;
  const tools = definitions
    .map((definition, i): ToolMeasure => {
      const tokens = counts.perTool[i] ?? 0;
      const schemaJson = stringify(definition.input_schema, definition.name);
      const shape = schemaShape(definition.input_schema);
      return {
        name: definition.name,
        tokens,
        share: total > 0 ? Math.round((tokens / total) * 10_000) / 10_000 : 0,
        chars: stringify(definition, definition.name).length,
        descriptionChars: definition.description?.length ?? 0,
        schemaChars: schemaJson.length,
        schemaDepth: shape.depth,
        schemaProperties: shape.properties,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || compareNames(a.name, b.name));

  return {
    tool: 'mcp-footprint',
    version: VERSION,
    source: input.source,
    server: input.server,
    counter: counter.info,
    total: {
      tools: tools.length,
      tokens: total,
      chars: tools.reduce((sum, t) => sum + t.chars, 0),
      pages: input.pages,
    },
    overhead: counts.overhead,
    tools,
    offenders: {
      longestDescriptions: top(tools, (t) => t.descriptionChars),
      deepestSchemas: top(tools, (t) => t.schemaDepth),
      biggestSchemas: top(tools, (t) => t.schemaChars),
    },
    prompts: await measureList(input.prompts, counter, ['name', 'description', 'arguments']),
    resources: await measureList(input.resources, counter, ['uri', 'name', 'description', 'mimeType']),
    budget: null,
    warnings: duplicateNames(definitions.map((d) => d.name)),
  };
}

/** Tool names must be unique within a server; clients differ on what they do when they are not. */
function duplicateNames(names: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => `${count} tools are named "${name}"; a client may reject the server or keep only one of them`);
}

/** JSON.stringify recurses, so a schema nested tens of thousands of levels deep throws RangeError. */
function stringify(value: unknown, tool: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    if (error instanceof RangeError) throw new FootprintError(`tool "${tool}": schema is nested too deep to serialize`);
    throw error;
  }
}

/** Code-unit order, so results do not depend on the machine's locale. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function top(tools: readonly ToolMeasure[], value: (tool: ToolMeasure) => number): Ranked[] {
  return tools
    .map((tool) => ({ name: tool.name, value: value(tool) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || compareNames(a.name, b.name))
    .slice(0, OFFENDERS);
}

/** Counts the fields a client would show, as one JSON array. */
async function measureList(
  items: readonly Record<string, unknown>[] | null,
  counter: Counter,
  fields: readonly string[],
): Promise<ListMeasure | null> {
  if (items === null) return null;
  if (items.length === 0) return { count: 0, tokens: 0 };
  const picked = items.map((item) => Object.fromEntries(fields.filter((f) => item[f] !== undefined).map((f) => [f, item[f]])));
  return { count: items.length, tokens: await counter.countText(JSON.stringify(picked)) };
}

export function withBudget(report: Report, limit: number | undefined): Report {
  if (limit === undefined) return report;
  return { ...report, budget: { limit, over: report.total.tokens > limit } };
}
