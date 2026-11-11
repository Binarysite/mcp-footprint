import { readFileSync } from 'node:fs';

function readVersion(): string {
  // dist/version.js in a package, build/src/version.js under test.
  for (const relative of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'mcp-footprint' && pkg.version) return pkg.version;
    } catch {
      // Try the next location.
    }
  }
  return '0.0.0';
}

export const VERSION: string = readVersion();
