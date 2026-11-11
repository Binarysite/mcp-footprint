import { readFile } from 'node:fs/promises';
import { FootprintError } from './errors.js';
import type { McpToolLike } from './serialize.js';

/**
 * Reads saved tools from a file. Accepted shapes:
 *   [ tool, ... ]                        a bare array
 *   { "tools": [ ... ] }                 a tools/list result
 *   { "result": { "tools": [ ... ] } }   a JSON-RPC response
 */
export async function loadTools(path: string): Promise<McpToolLike[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new FootprintError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new FootprintError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseTools(data, path);
}

export function parseTools(data: unknown, where: string): McpToolLike[] {
  const list = Array.isArray(data) ? data : field(field(data, 'result') ?? data, 'tools');
  if (!Array.isArray(list)) {
    throw new FootprintError(`${where}: expected an array of tools, {"tools": [...]} or {"result": {"tools": [...]}}`);
  }
  return list.map((tool: unknown, i) => {
    const name = field(tool, 'name');
    const description = field(tool, 'description');
    const inputSchema = field(tool, 'inputSchema');
    if (typeof name !== 'string' || name === '') throw new FootprintError(`${where}: tool ${i} has no name`);
    if (description !== undefined && typeof description !== 'string') {
      throw new FootprintError(`${where}: tool "${name}" has a description that is not a string`);
    }
    if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new FootprintError(`${where}: tool "${name}" has no inputSchema object`);
    }
    return { name, ...(description !== undefined && { description }), inputSchema: inputSchema as Record<string, unknown> };
  });
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
