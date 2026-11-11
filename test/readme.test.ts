import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { renderText } from '../src/render.js';
import { README, readReports, renderTable, SAMPLE, updateReadme } from '../scripts/readme.js';
import { VERSION } from '../src/version.js';

const readme = await readFile(README, 'utf8');
const reports = await readReports();

test('README.md is up to date with reports/ (run npm run readme)', () => {
  assert.equal(updateReadme(readme, reports), readme);
});

test('the reference table has one row per report, largest first', () => {
  const rows = renderTable(reports)
    .split('\n')
    .filter((line) => line.startsWith('| `'));
  assert.equal(rows.length, reports.size);
  const totals = rows.map((row) => Number(row.split('|')[4]?.trim().replace(/,/g, '')));
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
  for (const report of reports.values()) {
    assert.ok(rows.some((row) => row.includes(`\`${report.package}\``) && row.includes(` ${report.version} `)));
  }
});

test('the sample output is the CLI text output for the sample report', () => {
  const sample = reports.get(SAMPLE);
  assert.ok(sample);
  assert.ok(readme.includes(renderText(sample.report).trimEnd()));
});

test('README follows the house style: no em dashes', () => {
  assert.doesNotMatch(readme, /\u2014/);
});

test('the sample installs this release, and only the note names the measuring version', () => {
  assert.ok(readme.includes(`$ npx github:Binarysite/mcp-footprint#v${VERSION} -- `));
  const sample = reports.get(SAMPLE);
  assert.ok(sample);
  assert.ok(renderTable(reports).includes(`mcp-footprint ${sample.report.version}`));
});

const actionPins = (text: string) =>
  new Map(
    [...text.matchAll(/uses: (actions\/[\w-]+)@([0-9a-f]{40}) # (v[\d.]+)/g)].map(([, name, sha, version]) => [
      name,
      `${sha} # ${version}`,
    ]),
  );

test('every third-party action the README pins is pinned to the same commit as the CI', async () => {
  const ci = actionPins(await readFile(join(dirname(README), '.github/workflows/ci.yml'), 'utf8'));
  const pins = actionPins(readme);
  assert.ok(pins.size > 0, 'the README pins at least one action');
  assert.doesNotMatch(readme, /uses: [\w./-]+@(?![0-9a-f]{40} # v)/, 'every uses: line is pinned by commit SHA');
  for (const [name, pin] of pins) assert.equal(pin, ci.get(name), `${name} in README vs ci.yml`);
});

test('the README action example is pinned by commit to this release', () => {
  const tag = readme.match(/uses: Binarysite\/mcp-footprint@[0-9a-f]{40} # (v[\d.]+)/)?.[1];
  assert.equal(tag, `v${VERSION}`);
});
