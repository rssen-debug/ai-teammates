/**
 * MAJIN V4 — MCP tools as V2 tool definitions.
 *
 * An MCP server can do anything its author wrote: read files, drive a browser,
 * control a desktop. So an MCP tool is registered at the `process` tier — held by
 * the approval layer — unless the owner has explicitly lowered it. That is the
 * same rule the shell lane follows, for the same reason.
 *
 * Names are prefixed `mcp_<server>_<tool>` so two servers offering "read" cannot
 * collide, and so a receipt says which server acted.
 */
import { z } from 'zod';

/**
 * Carry a model-facing JSON Schema through V2's registry.
 *
 * V2's `ToolDefinition` is a zod object, and zod strips unknown keys — so a
 * `jsonSchema` field on the definition is silently dropped by `registry.define()`.
 * `inputSchema` itself only has to be non-null, so the JSON Schema rides there,
 * as a non-enumerable property that cannot collide with zod's own API.
 */
export function withModelSchema(zodSchema, jsonSchema) {
  if (jsonSchema && typeof jsonSchema === 'object') {
    try {
      Object.defineProperty(zodSchema, 'modelJsonSchema', {
        value: jsonSchema, enumerable: false, configurable: true, writable: false,
      });
    } catch { /* a frozen schema simply loses the hint; zod conversion is the fallback */ }
  }
  return zodSchema;
}

/** The JSON Schema a definition carries for the model, if any. */
export function modelSchemaOf(def) {
  const attached = def?.inputSchema?.modelJsonSchema;
  if (attached && typeof attached === 'object') return attached;
  if (def?.jsonSchema && typeof def.jsonSchema === 'object') return def.jsonSchema;
  return null;
}

/** MCP tool names are free-form; V2's registry wants `^[a-z][a-z0-9_]*$`. */
export function mcpToolName(serverName, toolName) {
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const name = `mcp_${clean(serverName)}_${clean(toolName)}`;
  if (!/^[a-z][a-z0-9_]*$/.test(name) || name.length > 80) return null;
  return name;
}

/**
 * Convert MCP tools into V2 definitions.
 *
 * The MCP `inputSchema` is JSON Schema, which is exactly what the model expects,
 * so it is carried through verbatim: a hand-written zod mirror would be a second
 * source of truth that drifts. `z.unknown()` is used only as V2's internal
 * contract; the real validation happens on the server, which is the authority on
 * its own arguments.
 */
export function adaptMcpTools(serverName, tools, { call, tier = 'process' } = {}) {
  const out = [];
  for (const tool of tools) {
    const name = mcpToolName(serverName, tool.name);
    if (!name) continue; // an unusable name is skipped, and the caller reports it
    out.push({
      name,
      description: `${tool.description || tool.name} (MCP: ${serverName})`.slice(0, 400),
      tier,
      sourceName: `${serverName}/${tool.name}`,
      // Carried for the model, not for validation: see the note above.
      inputSchema: withModelSchema(z.record(z.string(), z.unknown()).optional(), tool.inputSchema),
      outputSchema: z.object({
        text: z.string(),
        isError: z.boolean(),
      }),
      execute: async (input = {}) => {
        const result = await call(tool.name, input);
        if (result.isError) {
          const err = new Error(result.text || `MCP tool ${tool.name} reported an error`);
          err.cls = 'TOOL_FAILURE';
          throw err;
        }
        return { text: result.text, isError: false };
      },
    });
  }
  return out;
}

/**
 * Register every tool a connected MCP server offers.
 *
 * `registry` is the V4 registry (the built-ins), so an MCP tool inherits the
 * runner, the approval policy, timeouts and receipts.
 */
export function registerMcpTools(registry, serverName, tools, { server, tier = 'process' } = {}) {
  if (!server || typeof server.callTool !== 'function') {
    throw new Error('registerMcpTools needs a connected server');
  }
  const defs = adaptMcpTools(serverName, tools, {
    call: (name, args) => server.callTool(name, args),
    tier,
  });
  const registered = [];
  const skipped = [];
  for (const def of defs) {
    try {
      registry.define(def);
      registered.push({ name: def.name, tier: def.tier, sourceName: def.sourceName });
    } catch (err) {
      skipped.push({ name: def.name, reason: String(err?.message || err) });
    }
  }
  // A tool whose name could not be mapped at all never reached `defs`.
  for (const tool of tools) {
    if (!mcpToolName(serverName, tool.name)) skipped.push({ name: tool.name, reason: 'unmappable tool name' });
  }
  return { registered, skipped };
}

/**
 * The model-facing schema list for MCP tools.
 *
 * V4's `schemasFromRegistry()` converts zod; MCP tools already carry JSON Schema,
 * so this exposes it directly and keeps the real parameter names visible.
 */
export function mcpModelSchemas(registry) {
  const out = [];
  for (const summary of registry.list()) {
    const def = registry.get(summary.name);
    const schema = modelSchemaOf(def);
    if (!schema) continue;
    out.push({
      name: def.name,
      description: def.description,
      parameters: schema.type === 'object' ? schema : { type: 'object', properties: {} },
    });
  }
  return out;
}
