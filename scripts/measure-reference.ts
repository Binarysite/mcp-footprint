// Measures the official reference servers and writes reports/<name>.json.
//
//   npm run measure:reference          (needs Node >= 24, the servers' engines)
//
// Each server is installed with --ignore-scripts into its own temp dir, then
// started by the built CLI with an empty temp dir as its working directory
// and HOME, and no environment beyond PATH. Nothing else is executed.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Report } from '../src/measure.js';

export interface ReferenceServer {
  /** File name under reports/. */
  id: string;
  package: string;
  version: string;
  /** Path of the bin inside the package. */
  bin: string;
  /** Arguments; "<workdir>" becomes the empty working directory. */
  args: string[];
}

export const SERVERS: ReferenceServer[] = [
  { id: 'server-everything', package: '@modelcontextprotocol/server-everything', version: '2.3.0', bin: 'dist/index.js', args: [] },
  {
    id: 'server-filesystem',
    package: '@modelcontextprotocol/server-filesystem',
    version: '2.3.0',
    bin: 'dist/index.js',
    args: ['<workdir>'],
  },
  { id: 'server-memory', package: '@modelcontextprotocol/server-memory', version: '2.1.1', bin: 'dist/index.js', args: [] },
  {
    id: 'server-sequential-thinking',
    package: '@modelcontextprotocol/server-sequential-thinking',
    version: '2.1.1',
    bin: 'dist/index.js',
    args: [],
  },
];

export interface ReferenceReport {
  package: string;
  version: string;
  /** npm's integrity hash for the tarball that was measured. */
  integrity: string;
  measuredAt: string;
  node: string;
  tokenizer: string;
  launch: { command: string[]; cwd: string; env: string[] };
  report: Report;
  toolsList: { tools: unknown[] };
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'build/src/bin.js');

async function measureOne(server: ReferenceServer, date: string): Promise<ReferenceReport> {
  const install = await mkdtemp(join(tmpdir(), 'mcpf-install-'));
  const workdir = await mkdtemp(join(tmpdir(), 'mcpf-workdir-'));
  const scratch = await mkdtemp(join(tmpdir(), 'mcpf-out-'));
  try {
    await writeFile(join(install, 'package.json'), '{"private":true}\n');
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `${server.package}@${server.version}`], {
      cwd: install,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const lock = JSON.parse(await readFile(join(install, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string; integrity: string }>;
    };
    const locked = lock.packages[`node_modules/${server.package}`];
    if (locked?.version !== server.version) throw new Error(`${server.package}: installed ${String(locked?.version)}`);

    const serverPath = join(install, 'node_modules', server.package, server.bin);
    const args = server.args.map((arg) => (arg === '<workdir>' ? workdir : arg));
    const toolsPath = join(scratch, 'tools.json');
    const env = { PATH: process.env.PATH ?? '', HOME: workdir };
    const stdout = execFileSync(
      process.execPath,
      [cli, '--json', '--timeout', '60000', '--save-tools', toolsPath, '--', process.execPath, serverPath, ...args],
      { cwd: workdir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );

    const tiktoken = JSON.parse(await readFile(join(root, 'node_modules/js-tiktoken/package.json'), 'utf8')) as { version: string };
    const result: ReferenceReport = {
      package: server.package,
      version: server.version,
      integrity: locked.integrity,
      measuredAt: date,
      node: process.version,
      tokenizer: `o200k_base via js-tiktoken ${tiktoken.version}`,
      launch: { command: [process.execPath, serverPath, ...args], cwd: workdir, env: ['PATH', 'HOME=<workdir>'] },
      report: JSON.parse(stdout) as Report,
      toolsList: JSON.parse(await readFile(toolsPath, 'utf8')) as { tools: unknown[] },
    };
    return anonymize(result, { [install]: '<install>', [workdir]: '<workdir>', [process.execPath]: 'node' });
  } finally {
    await Promise.all([install, workdir, scratch].map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

/** Replaces machine paths so committed reports contain no local details. */
function anonymize<T>(value: T, replacements: Record<string, string>): T {
  let text = JSON.stringify(value);
  // Longest first, so a path is never half-replaced by a prefix of it.
  for (const [from, to] of Object.entries(replacements).sort((a, b) => b[0].length - a[0].length)) {
    // macOS reports some temp paths through the /private symlink.
    text = text.split(`/private${from}`).join(to).split(from).join(to);
  }
  const leak = /\/(Users|home|private|var\/folders|tmp)\//.exec(text);
  if (leak) throw new Error(`report still contains a local path near: ${text.slice(Math.max(0, leak.index - 40), leak.index + 40)}`);
  return JSON.parse(text) as T;
}

async function mainScript(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`the reference servers need Node >= 24; this is ${process.version}`);
  const date = new Date().toISOString().slice(0, 10);
  const only = process.argv.slice(2);
  for (const server of SERVERS.filter((s) => only.length === 0 || only.includes(s.id))) {
    process.stderr.write(`measuring ${server.package}@${server.version}\n`);
    const report = await measureOne(server, date);
    await writeFile(join(root, 'reports', `${server.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`  ${report.report.total.tools} tools, ${report.report.total.tokens} o200k tokens\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await mainScript();
