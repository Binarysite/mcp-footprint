import type { ListMeasure, Ranked, Report } from './measure.js';

const fmt = new Intl.NumberFormat('en-US');
const n = (value: number): string => fmt.format(value);
const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** The human-readable report. Plain text, no color, stable for snapshots. */
export function renderText(report: Report): string {
  const { counter, total } = report;
  const lines: string[] = [];

  const subject = report.server
    ? `${report.server.name} ${report.server.version}`
    : report.source.kind === 'file'
      ? report.source.path
      : (report.source.command[0] ?? 'server');
  const pages = total.pages === null ? '' : `, ${plural(total.pages, 'page')}`;
  lines.push(`${subject}: ${plural(total.tools, 'tool')}${pages}`);
  lines.push(`counted with ${counter.label}`);
  lines.push('');

  const width = Math.max(counter.unit.length, n(total.tokens).length);
  const row = (tokens: string, share: string, name: string): string =>
    `  ${tokens.padStart(width)}  ${share.padStart(6)}  ${name}`;
  lines.push(row(counter.unit, 'share', 'tool'));
  for (const tool of report.tools) lines.push(row(n(tool.tokens), pct(tool.share), tool.name));
  if (report.overhead !== 0) {
    const share = total.tokens > 0 ? report.overhead / total.tokens : 0;
    lines.push(row(n(report.overhead), pct(share), '(tool-use overhead, not tied to one tool)'));
  }
  lines.push(row(n(total.tokens), total.tokens > 0 ? '100.0%' : '-', 'total'));

  const { longestDescriptions, deepestSchemas, biggestSchemas } = report.offenders;
  if (report.tools.length > 0) {
    lines.push('');
    lines.push(`longest descriptions  ${ranked(longestDescriptions, (v) => `${n(v)} chars`)}`);
    lines.push(`deepest schemas       ${ranked(deepestSchemas, (v) => `depth ${v}`)}`);
    lines.push(`biggest schemas       ${ranked(biggestSchemas, (v) => `${n(v)} chars`)}`);
  }

  const extras = [listLine('prompts', report.prompts, counter.unit), listLine('resources', report.resources, counter.unit)];
  if (extras.some((line) => line !== null)) {
    lines.push('');
    for (const line of extras) if (line !== null) lines.push(line);
  }

  if (report.budget) {
    const { limit, over } = report.budget;
    const verdict = over ? `over by ${n(total.tokens - limit)}` : 'ok';
    lines.push('');
    lines.push(`budget     ${n(total.tokens)} of ${n(limit)} ${counter.unit}: ${verdict}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function plural(count: number, word: string): string {
  return `${n(count)} ${word}${count === 1 ? '' : 's'}`;
}

function ranked(entries: readonly Ranked[], describe: (value: number) => string): string {
  if (entries.length === 0) return '-';
  return entries.map((e) => `${e.name} (${describe(e.value)})`).join(', ');
}

function listLine(label: string, list: ListMeasure | null, unit: string): string | null {
  if (list === null) return null;
  return `${label.padEnd(10)} ${n(list.count)}, ${n(list.tokens)} ${unit} (not in the total)`;
}
