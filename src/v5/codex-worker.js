import { createDriverTools } from './codex-tools.js';
import { killActiveShellChildren } from '../core/tools/shell.js';

// Protocol stdout belongs exclusively to the parent MCP server.
console.log = (...args) => console.error(...args);
const tools = await createDriverTools(JSON.parse(process.env.MAJIN_DRIVER_OPTIONS));
process.send({ ready: true, tools: [...tools.values()].map(({ run, ...t }) => t) });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Kill foreground shell trees first: on Windows, force-killing this worker
  // can otherwise orphan a shell's child process, which could still produce
  // a late effect after the host reported the operation cancelled.
  try { killActiveShellChildren(); } catch { /* hard parent kill remains the fallback */ }
  try {
    const closing = tools.get('browser_close')?.run({});
    if (closing) await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 5000))]);
  } catch { /* the parent is gone; exit is the cleanup boundary */ }
  process.exit(0);
}

process.on('disconnect', shutdown);
process.on('message', async (msg) => {
  if (msg?.type === 'shutdown') return shutdown();
  const { id, name, args } = msg || {};
  try { process.send({ id, value: await tools.get(name).run(args) }); }
  catch (error) { process.send({ id, value: { ok: false, error: { code: error.code || 'TOOL_FAILURE', message: error.message, ...(error.meta ? { meta: error.meta } : {}), ...(error.details ? { details: error.details } : {}) } } }); }
});
