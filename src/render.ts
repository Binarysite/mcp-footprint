import { deltaParts } from './baseline.js';
import type { ListMeasure, Ranked, Report } from './measure.js';

const fmt = new Intl.NumberFormat('en-US');
const n = (value: number): string => fmt.format(value);
/**
 * Names, versions and paths come from the server or a file, so they can carry
 * escape sequences that clear the screen, retitle the window or forge report
 * rows. Control characters become U+FFFD and long values are cut.
 */
export const MAX_TEXT_WIDTH = 120;
/* eslint-disable no-control-regex -- matching control characters is the point */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
/* eslint-enable no-control-regex */

export function sanitize(text: string, max = MAX_TEXT_WIDTH): string {
  const clean = text.replace(CONTROL, '\uFFFD');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** For multi-line messages: keeps \n and \t, neutralises everything else. */
export function sanitizeMessage(text: string): string {
  return text.replace(CONTROL_EXCEPT_NEWLINE_TAB, '\uFFFD');
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** The human-readable report. Plain text, no color, stable for snapshots. */
export function renderText(report: Report): string {
  const { counter, total } = report;
  const lines: string[] = [];

  const subject = sanitize(
    report.server
      ? `${report.server.name} ${report.server.version}`
      : report.source.kind === 'file'
        ? report.source.path
        : (report.source.command[0] ?? 'server'),
  );
  const pages = total.pages === null ? '' : `, ${plural(total.pages, 'page')}`;
  lines.push(`${subject}: ${plural(total.tools, 'tool')}${pages}`);
  lines.push(`counted with ${counter.label}`);
  lines.push('');

  const width = Math.max(counter.unit.length, n(total.tokens).length);
  const row = (tokens: string, share: string, name: string): string =>
    `  ${tokens.padStart(width)}  ${share.padStart(6)}  ${name}`;
  lines.push(row(counter.unit, 'share', 'tool'));
  for (const tool of report.tools) lines.push(row(n(tool.tokens), pct(tool.share), sanitize(tool.name)));
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

  if (report.baseline) {
    const { total: change, details } = deltaParts(report.baseline);
    lines.push('');
    lines.push(`baseline   ${change} vs ${sanitize(report.baseline.path)}`);
    if (details.length > 0) lines.push(`           ${details.map((d) => sanitize(d, 4 * MAX_TEXT_WIDTH)).join('; ')}`);
  }

  if (report.budget) {
    const { limit, over } = report.budget;
    const verdict = over ? `over by ${n(total.tokens - limit)}` : 'ok';
    lines.push('');
    lines.push(`budget     ${n(total.tokens)} of ${n(limit)} ${counter.unit}: ${verdict}`);
  }
  if (report.warnings.length > 0) {
    lines.push('');
    for (const warning of report.warnings) lines.push(`warning: ${sanitize(warning, 2 * MAX_TEXT_WIDTH)}`);
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
  return entries.map((e) => `${sanitize(e.name)} (${describe(e.value)})`).join(', ');
}

function listLine(label: string, list: ListMeasure | null, unit: string): string | null {
  if (list === null) return null;
  return `${label.padEnd(10)} ${n(list.count)}, ${n(list.tokens)} ${unit} (not in the total)`;
}
