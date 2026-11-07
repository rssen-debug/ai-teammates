/**
 * V2 builtin tools — small, honest, schema-locked.
 * Wrapped around primitives that already exist (sandboxed exec, verifiers).
 */
import { z } from 'zod';
import path from 'node:path';
import { runVerifier } from '../runtime/verifiers.js';

/** read_file(workspace-relative, size-capped) */
export const readFileTool = (root) => ({
  name: 'read_file', tier: 'read', description: 'read a small file inside the workspace root',
  inputSchema: z.object({ path: z.string().min(1).max(500) }),
  outputSchema: z.object({ path: z.string(), length: z.number(), content: z.string().max(64_000) }),
  execute: async ({ path: p }) => {
    const fs = await import('node:fs');
    const abs = path.resolve(root, p);
    if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) throw new Error('path escapes root');
    const buf = fs.readFileSync(abs);
    return { path: p, length: buf.length, content: buf.toString('utf8', 0, 64_000) };
  },
});

/** write small text file (write tier = HOLD by default) */
export const writeFileTool = (root) => ({
  name: 'write_file', tier: 'write', description: 'write a small text file inside the workspace root',
  inputSchema: z.object({ path: z.string().min(1).max(500), content: z.string().max(64_000) }),
  outputSchema: z.object({ path: z.string(), bytes: z.number() }),
  execute: async ({ path: p, content }) => {
    const fs = await import('node:fs');
    const abs = path.resolve(root, p);
    if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) throw new Error('path escapes root');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { path: p, bytes: content.length };
  },
});

/** verify_now: run any V2 verifier on demand (evidence of state, receipts elsewhere) */
export const verifyNowTool = {
  name: 'verify_now', tier: 'read', description: 'run a V2 verifier kind (file/json/http/pixel/dom/memory) on a spec',
  inputSchema: z.object({
    kind: z.enum(['file', 'json', 'http', 'pixel', 'dom', 'memory']),
    spec: z.object({}).passthrough(),
  }),
  outputSchema: z.object({
    verified: z.boolean(),
    errorCls: z.string().nullable(),
  }),
  execute: async ({ kind, spec }) => {
    const r = await runVerifier(kind, spec);
    return { verified: !!r.verified, errorCls: r.error?.cls || null };
  },
};

export function builtinTools(root) {
  return [readFileTool(root), writeFileTool(root), verifyNowTool];
}
