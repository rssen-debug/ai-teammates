/**
 * V2 tool registry (master brief sections 110-116): first-class tools with
 * zod contracts on BOTH sides. A tool is never invoked directly: it goes
 * through the runner which validates input, applies policy+consent, executes,
 * validates output, and receipts everything. Model-authored outputs that
 * break their own schema are classified, never repaired (4.2).
 */
import { z } from 'zod';

export const TOOL_SCHEMA = 'majin.v2.tool/v1';

/** tool capability tier -> default approval behavior (extends earlier modes) */
export const TOOL_TIERS = Object.freeze(['read', 'write', 'process', 'browser', 'external']);

export const ToolDefinition = z.object({
  name: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(4).max(400),
  tier: z.enum(TOOL_TIERS),
  inputSchema: z.custom((s) => s != null),
  outputSchema: z.custom((s) => s != null),
  execute: z.custom((fn) => typeof fn === 'function'),
});

export class ToolRegistry {
  constructor() { this.tools = new Map(); }

  define(def) {
    const parsed = ToolDefinition.parse(def);
    this.tools.set(parsed.name, parsed);
    return parsed;
  }

  get(name) { return this.tools.get(name) || null; }
  list() { return [...this.tools.values()].map(({ name, description, tier }) => ({ name, description, tier })); }
}

export const ToolCall = z.object({
  tool: z.string().min(1),
  input: z.unknown(),
  callId: z.string().optional(),
});

export class ToolError extends Error {
  constructor(cls, message, meta = {}) { super(message); this.name = 'ToolError'; this.cls = cls; this.meta = meta; }
}
