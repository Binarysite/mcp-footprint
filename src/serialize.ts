/** The fields of an MCP tool that model APIs receive. */
export interface McpToolLike {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

/**
 * A tool as a model API receives it. This is the Anthropic Messages API
 * shape; OpenAI's function shape carries the same three fields under
 * different names. MCP-only fields (title, annotations, outputSchema, _meta,
 * icons) are dropped because clients do not forward them to the model.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export function toToolDefinition(tool: McpToolLike): ToolDefinition {
  return {
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    input_schema: tool.inputSchema,
  };
}

/** Compact JSON, the form the token counts are taken from. */
export function serialize(definition: ToolDefinition): string {
  return JSON.stringify(definition);
}

export interface SchemaShape {
  /** JSON nesting depth: {} is 1, {"properties":{"a":{}}} is 3. */
  depth: number;
  /** Keys of every "properties" object anywhere in the schema. */
  properties: number;
}

/**
 * Walks the schema with an explicit stack: a server controls the schema, and a
 * recursive walk overflows the call stack on a few thousand nested levels.
 */
export function schemaShape(schema: unknown): SchemaShape {
  let properties = 0;
  let depth = 0;
  // isMap: value is the object under a "properties" keyword, so its keys are
  // property names, and a property may itself be called "properties".
  const stack: { value: unknown; isMap: boolean; level: number }[] = [{ value: schema, isMap: false, level: 1 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, isMap, level } = item;
    if (value === null || typeof value !== 'object') continue;
    depth = Math.max(depth, level);
    if (Array.isArray(value)) {
      for (const child of value as unknown[]) stack.push({ value: child, isMap: false, level: level + 1 });
      continue;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (isMap) properties += entries.length;
    for (const [key, child] of entries) stack.push({ value: child, isMap: !isMap && key === 'properties', level: level + 1 });
  }
  return { depth, properties };
}
