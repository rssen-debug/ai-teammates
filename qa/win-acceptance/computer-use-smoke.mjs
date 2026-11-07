#!/usr/bin/env node
/**
 * Windows acceptance A5: actual computer.use tool registry / dry-plan probe.
 * Deliberately NO desktop actuation or model request. Exit status reports
 * wiring only; an installed, interactive GUI still requires A1/A2+ checks.
 */
// Dynamic import: a static import would escape this probe's error handling
// entirely when the tool module itself fails to load (as it did on a real
// Windows Actions runner, surfaced only as a bare stack + node banner).
let computerTools;
try {
  ({ computerTools } = await import('../../src/core/tools/computer.js'));
} catch (err) {
  console.error('BLOCKED: tool module itself failed to load');
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}

const tool = computerTools.find(t => t.name === 'computer.use');
if (!tool || typeof tool.run !== 'function') {
  console.error('BLOCKED: computer.use tool is absent from registry');
  process.exitCode = 1;
} else {
  try {
    const result = await tool.run({
      goal: 'QA dry-plan: describe a hypothetical action, do not control the desktop',
      modelCallsOff: 'true',
    }, { session: 'win-acceptance-dry-plan' });
    const okay = result?.ok === true &&
      typeof result.meta?.version === 'string' &&
      result.meta.engine === 'OBSERVE→PLAN→ACT→VERIFY→RECOVER' &&
      Array.isArray(result.meta.actions) &&
      result.meta.actions.includes('capture') &&
      /DRY-PLAN/i.test(result.result || '');
    if (!okay) {
      console.error('BLOCKED: real tool did not return a valid dry-plan contract');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({
        tool: tool.name,
        version: result.meta.version,
        mode: 'DRY_PLAN_ONLY',
        desktopActionsExecuted: 0,
        planningStages: result.meta.engine,
      }));
    }
  } catch (err) {
    console.error('BLOCKED: computer.use dry-plan failed: ' + String(err?.message || err));
    process.exitCode = 1;
  }
}
