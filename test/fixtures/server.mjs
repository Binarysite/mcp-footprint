#!/usr/bin/env node
// A small MCP server with known tools, built on the official server SDK.
//
//   node server.mjs [--page-size N] [--repeat-cursor] [--no-extras]
//
// --page-size N    serve tools/list in pages of N, linked by nextCursor
// --repeat-cursor  always answer with the same nextCursor (a broken server)
// --no-extras      do not advertise prompts or resources
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const pageSizeIndex = argv.indexOf('--page-size');
const pageSize = pageSizeIndex === -1 ? Infinity : Number(argv[pageSizeIndex + 1]);
const extras = !flag('--no-extras');

const { tools } = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));

const server = new Server(
  { name: 'fixture', version: '1.2.3' },
  { capabilities: { tools: {}, ...(extras && { prompts: {}, resources: {} }) } },
);

server.setRequestHandler('tools/list', (request) => {
  const start = Number(request.params?.cursor ?? 0);
  const end = Math.min(start + pageSize, tools.length);
  const page = { tools: tools.slice(start, end) };
  if (flag('--repeat-cursor')) page.nextCursor = '1';
  else if (end < tools.length) page.nextCursor = String(end);
  return page;
});

if (extras) {
  server.setRequestHandler('prompts/list', () => ({
    prompts: [
      {
        name: 'triage',
        description: 'Triage an issue by severity.',
        arguments: [{ name: 'issue', description: 'Issue number', required: true }],
      },
    ],
  }));
  server.setRequestHandler('resources/list', () => ({
    resources: [
      { uri: 'fixture://readme', name: 'readme', description: 'The project readme.', mimeType: 'text/markdown' },
      { uri: 'fixture://changelog', name: 'changelog', mimeType: 'text/markdown' },
    ],
  }));
}

await server.connect(new StdioServerTransport());
