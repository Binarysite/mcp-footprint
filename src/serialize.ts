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

export function schemaShape(schema: unknown): SchemaShape {
  let properties = 0;
  // isMap: value is the object under a "properties" keyword, so its keys are
  // property names, and a property may itself be called "properties".
  const visit = (value: unknown, isMap: boolean): number => {
    if (value === null || typeof value !== 'object') return 0;
    if (Array.isArray(value)) {
      return 1 + value.reduce((deepest: number, child: unknown) => Math.max(deepest, visit(child, false)), 0);
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (isMap) properties += entries.length;
    let deepest = 0;
    for (const [key, child] of entries) deepest = Math.max(deepest, visit(child, !isMap && key === 'properties'));
    return 1 + deepest;
  };
  return { depth: visit(schema, false), properties };
}
