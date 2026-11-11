#!/usr/bin/env node
// A hand-written MCP server for malformed tools/list results the SDK server
// would refuse to send.
//
//   node raw-server.mjs deep <levels>   one tool whose schema is nested <levels> deep
//   node raw-server.mjs invalid         30 tools whose inputSchema is not an object schema
import { createInterface } from 'node:readline';

const [mode, levels = '2000'] = process.argv.slice(2);
const deep = () => '{"type":"object","properties":{"a":'.repeat(Number(levels)) + '{}' + '}}'.repeat(Number(levels));
const tools =
  mode === 'deep'
    ? `[{"name":"deep","inputSchema":${deep()}}]`
    : JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'string', properties: 5 } })));

const reply = (id, result) => process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${result}}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    reply(
      message.id,
      JSON.stringify({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'raw', version: '1.0.0' } }),
    );
  } else if (message.method === 'tools/list') {
    reply(message.id, `{"tools":${tools}}`);
  }
});
