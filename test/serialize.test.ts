import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaShape, serialize, toToolDefinition } from '../src/serialize.js';

test('keeps name, description and input schema, in that order, and drops MCP-only fields', () => {
  const tool = {
    name: 'echo',
    title: 'Echo',
    description: 'Echo it.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
    _meta: { a: 1 },
  };
  assert.equal(serialize(toToolDefinition(tool)), '{"name":"echo","description":"Echo it.","input_schema":{"type":"object"}}');
});

test('omits a missing description instead of sending null', () => {
  assert.equal(serialize(toToolDefinition({ name: 'ping', inputSchema: { type: 'object' } })), '{"name":"ping","input_schema":{"type":"object"}}');
});

test('schema depth is JSON nesting depth', () => {
  assert.equal(schemaShape({}).depth, 1);
  assert.equal(schemaShape({ type: 'object', properties: { a: { type: 'string' } } }).depth, 3);
  assert.equal(schemaShape({ enum: ['a', 'b'] }).depth, 2);
  assert.equal(schemaShape({ a: [[{}]] }).depth, 4);
  assert.equal(schemaShape('not a schema').depth, 0);
});

test('counts properties at every level, including one named "properties"', () => {
  const schema = {
    type: 'object',
    properties: {
      properties: { type: 'string' },
      filters: { type: 'object', properties: { state: {}, labels: { type: 'array', items: { properties: { x: {} } } } } },
    },
  };
  assert.equal(schemaShape(schema).properties, 5);
});

test('handles very wide arrays without exhausting the stack', () => {
  const wide = { enum: Array.from({ length: 200_000 }, (_, i) => i) };
  assert.equal(schemaShape(wide).depth, 2);
});
