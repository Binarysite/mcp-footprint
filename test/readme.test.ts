import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderText } from '../src/render.js';
import { README, readReports, renderTable, SAMPLE, updateReadme } from '../scripts/readme.js';

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
