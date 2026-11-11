#!/usr/bin/env node
// A server that never answers. It ignores SIGTERM and starts a grandchild
// that also ignores SIGTERM, so only a SIGKILL to the process group stops
// both. Writes "<own pid> <grandchild pid>" to the file given as argv[2].
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
  stdio: 'ignore',
});
writeFileSync(process.argv[2], `${process.pid} ${grandchild.pid}`);
process.stdin.resume();
setInterval(() => {}, 1000);
