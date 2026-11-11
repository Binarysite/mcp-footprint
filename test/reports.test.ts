import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { O200kCounter } from '../src/counters.js';
import { parseTools } from '../src/load.js';
import { MAX_TOOL_BYTES, measure } from '../src/measure.js';
import { SERVERS, type ReferenceReport } from '../scripts/measure-reference.js';

const dir = new URL('../../reports/', import.meta.url);
const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
const load = async (file: string): Promise<{ raw: string; report: ReferenceReport }> => {
  const raw = await readFile(new URL(file, dir), 'utf8');
  return { raw, report: JSON.parse(raw) as ReferenceReport };
};

test('every pinned reference server has a report for that exact version', async () => {
  assert.deepEqual(files, SERVERS.map((s) => `${s.id}.json`).sort());
  for (const server of SERVERS) {
    const { report } = await load(`${server.id}.json`);
    assert.equal(report.package, server.package);
    assert.equal(report.version, server.version);
    assert.equal(report.report.server?.version, server.serverVersion ?? server.version);
    assert.match(report.integrity, /^sha512-/);
    assert.equal(report.report.counter.mode, 'o200k');
  }
});

for (const file of files) {
  test(`${file}: the committed numbers follow from the committed tools/list`, async () => {
    const { report } = await load(file);
    const remeasured = await measure(
      {
        source: report.report.source,
        server: report.report.server,
        tools: parseTools(report.toolsList, file),
        pages: report.report.total.pages,
        prompts: null,
        resources: null,
      },
      await O200kCounter.load(),
    );
    assert.deepEqual(remeasured.tools, report.report.tools);
    assert.deepEqual(remeasured.total, report.report.total);
    assert.deepEqual(remeasured.offenders, report.report.offenders);
    assert.equal(remeasured.overhead, 0);
  });

  test(`${file}: every tool fits under the size cap with room to spare`, async () => {
    const { report } = await load(file);
    for (const tool of report.report.tools) assert.ok(tool.chars * 4 < MAX_TOOL_BYTES, `${tool.name}: ${tool.chars} chars`);
  });

  test(`${file}: contains no local paths, user names or secrets`, async () => {
    const { raw, report } = await load(file);
    assert.doesNotMatch(raw, /\/(Users|home)\/|\/private\/|\/var\/folders\//);
    assert.doesNotMatch(raw, /sk-ant-|ghp_|gho_|github_pat_/);
    assert.deepEqual(report.launch.env, ['PATH', 'HOME=<workdir>']);
    assert.equal(report.launch.cwd, '<workdir>');
  });
}
