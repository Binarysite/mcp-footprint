#!/usr/bin/env node
import { main } from './cli.js';

const controller = new AbortController();
process.once('SIGINT', () => {
  controller.abort();
});
process.once('SIGTERM', () => {
  controller.abort();
});

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  signal: controller.signal,
});
