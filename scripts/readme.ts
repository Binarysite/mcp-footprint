// Regenerates the generated parts of README.md from reports/*.json.
//
//   npm run readme            rewrite README.md
//   npm run readme -- --check exit 1 if README.md is out of date
//
// test/readme.test.ts runs the same check, so a stale README fails CI.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderText } from '../src/render.js';
import { VERSION } from '../src/version.js';
import type { ReferenceReport } from './measure-reference.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const README = join(root, 'README.md');
export const REPORTS = join(root, 'reports');

/** The server whose full output is shown in the README. */
export const SAMPLE = 'server-memory';

/** Facts about a server that change how its number reads. */
const NOTES: Record<string, string> = {
  'server-everything':
    'registers five more tools for a client that declares roots, elicitation and sampling (`registerConditionalTools` in its `dist/tools/index.js`). mcp-footprint declares no client capabilities, so they are not counted.',
};

const fmt = new Intl.NumberFormat('en-US');

export async function readReports(): Promise<Map<string, ReferenceReport>> {
  const files = (await readdir(REPORTS)).filter((file) => file.endsWith('.json')).sort();
  const reports = new Map<string, ReferenceReport>();
  for (const file of files) {
    reports.set(file.replace(/\.json$/, ''), JSON.parse(await readFile(join(REPORTS, file), 'utf8')) as ReferenceReport);
  }
  return reports;
}

export function renderTable(reports: Map<string, ReferenceReport>): string {
  const rows = [...reports.entries()].sort(([, a], [, b]) => b.report.total.tokens - a.report.total.tokens);
  const lines = [
    '| Server | Version | Tools | o200k tokens | Most expensive tool | Report |',
    '| --- | ---: | ---: | ---: | --- | --- |',
  ];
  const notes: string[] = [];
  for (const [id, r] of rows) {
    const top = r.report.tools[0];
    const mark = NOTES[id] ? ` ${'*'.repeat(notes.length + 1)}` : '';
    if (NOTES[id]) notes.push(`${'\\*'.repeat(notes.length + 1)} \`${r.package}\` ${NOTES[id]}`);
    lines.push(
      `| \`${r.package}\`${mark} | ${r.version} | ${r.report.total.tools} | ${fmt.format(r.report.total.tokens)} | ${
        top ? `\`${top.name}\` (${fmt.format(top.tokens)})` : '-'
      } | [${id}.json](reports/${id}.json) |`,
    );
  }
  const conditions = new Set(rows.map(([, r]) => `${r.measuredAt}, Node ${r.node}, ${r.tokenizer}, mcp-footprint ${r.report.version}`));
  lines.push('');
  lines.push(`Measured ${[...conditions].join('; ')}.`);
  for (const note of notes) lines.push('', note);
  return lines.join('\n');
}

/**
 * The command installs the current release, so a reader who copies it gets
 * the hardened CLI. The release that took the measurement is in the
 * "Measured ..." note under the table.
 */
export function renderSample(report: ReferenceReport): string {
  return [
    '```text',
    `$ npx github:Binarysite/mcp-footprint#v${VERSION} -- npx -y ${report.package}@${report.version}`,
    renderText(report.report).trimEnd(),
    '```',
  ].join('\n');
}

function replaceBetween(text: string, name: string, content: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) throw new Error(`README.md is missing the ${name} markers`);
  return `${text.slice(0, from + start.length)}\n${content}\n${text.slice(to)}`;
}

export function updateReadme(text: string, reports: Map<string, ReferenceReport>): string {
  const sample = reports.get(SAMPLE);
  if (!sample) throw new Error(`reports/${SAMPLE}.json is missing`);
  return replaceBetween(replaceBetween(text, 'reference-table', renderTable(reports)), 'sample-output', renderSample(sample));
}

async function mainScript(): Promise<void> {
  const current = await readFile(README, 'utf8');
  const next = updateReadme(current, await readReports());
  if (process.argv.includes('--check')) {
    if (next !== current) {
      process.stderr.write('README.md is out of date; run npm run readme\n');
      process.exitCode = 1;
    }
    return;
  }
  await writeFile(README, next);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await mainScript();
