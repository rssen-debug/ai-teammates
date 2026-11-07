/**
 * MAJIN V6 — tool inventory.
 *
 * Counts are computed from the actual registries and (in deep mode) from the
 * real driver catalog, including every unavailable tool's reason. Historical
 * counts are explicitly a lower bound from declarations found in git history.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ALL_TOOLS } from '../core/tools/index.js';
import { browserTools } from '../core/tools/browser.js';
import { desktopAppTools } from '../core/tools/desktop-app.js';
import { builtinTools } from '../v2/tools/builtins.js';
import { V5_TOOL_UNIVERSE, driverToolName, laneForSourceTool } from '../v5/host-bridge.js';
import { hostCapabilities, V1_LANES } from '../v4/tools/host.js';
import { BRIDGE_TOOLS } from './bridge.js';
import { V6_TOOLS } from './mcp.js';

const HISTORY_PATHS = ['src/core/tools', 'src/v2/tools', 'src/v4/tools', 'src/v4/mcp-tools.js', 'src/v5/codex-tools.js'];
const DECLARATION = /^\+\s*name:\s*['"]([A-Za-z][A-Za-z0-9_.-]{1,60})['"]/gm;

/** Unique tool names ever declared in the tool-source paths (lower bound). */
export function historicalToolNames(repoRoot) {
  let patch = '';
  try {
    patch = execFileSync('git', ['log', '--all', '-p', '--unified=0', '--no-color', '--', ...HISTORY_PATHS], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    return { ok: false, names: [], error: String(error.message || error).slice(0, 300) };
  }
  const names = new Set();
  for (const match of patch.matchAll(DECLARATION)) names.add(match[1]);
  return { ok: true, names: [...names].sort(), method: 'unique `name:` declarations added in git history for tool source paths (lower bound)' };
}

export async function collectInventory({ repoRoot = process.cwd(), deep = false, history = false } = {}) {
  const caps = await hostCapabilities();
  const v1Tools = [...new Map([...ALL_TOOLS, ...browserTools, ...desktopAppTools].map((tool) => [tool.name, tool])).values()];
  const v2Tools = builtinTools(os.tmpdir());
  const laneAvailability = new Map();
  for (const [lane, entry] of Object.entries(caps.lanes)) laneAvailability.set(lane, { available: entry.available, reason: entry.reason, tools: entry.tools });

  const tools = v1Tools.map((tool) => {
    const lane = laneForSourceTool(tool.name);
    const laneEntry = laneAvailability.get(lane) || (lane === 'files' ? { available: true, tools: v1Tools.filter((t) => t.name.startsWith('fs.')).map((t) => t.name) } : null);
    const executableOnHost = Boolean(laneEntry?.available !== false && (!laneEntry?.tools?.length || laneEntry.tools.includes(tool.name)));
    const reason = executableOnHost ? null
      : laneEntry?.reason
        || (laneAvailability.get(lane)?.tools?.length ? 'Tool is missing from the loaded lane export on this build' : `Lane ${lane} is not available on this host`);
    return {
      name: tool.name,
      source: 'V1 registry (src/core/tools)',
      lane,
      risk: tool.risk || null,
      description: String(tool.desc || '').slice(0, 200),
      parameters: Object.keys(tool.raw || tool.parameters?.properties || {}),
      openCodeAdapter: driverToolName(tool.name),
      executableOnHost,
      unavailableReason: reason,
      credentialBoundary: ['github', 'channels', 'marketing', 'trading'].includes(lane)
        ? 'owner-configured external service and credentials'
        : null,
    };
  });

  const deepResult = deep ? await deepCatalog(repoRoot) : null;

  const mcpTools = [...BRIDGE_TOOLS, ...V6_TOOLS].map((tool) => ({
    name: tool.name, source: 'V6 MCP', description: tool.description.slice(0, 200),
  }));

  const inventory = {
    schema: 'majin.v6.inventory/v1',
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    counts: {
      currentV1Universe: V5_TOOL_UNIVERSE.length,
      currentV1Entries: v1Tools.length,
      currentV2Builtins: v2Tools.length,
      openCodeDriverAdapters: deepResult?.registered ?? null,
      openCodeAvailableNow: deepResult?.available ?? null,
      openCodeUnavailable: deepResult?.unavailable ?? null,
      openCodeMcpTools: mcpTools.length,
      lanesAvailable: Object.values(caps.lanes).filter((lane) => lane.available).length,
      lanesTotal: Object.keys(caps.lanes).length,
      historicalUniqueDeclarations: history ? historicalToolNames(repoRoot).names.length : null,
    },
    browserRuntime: caps.browserRuntime,
    deep: deepResult ? {
      registered: deepResult.registered,
      available: deepResult.available,
      unavailable: deepResult.unavailable,
      categories: deepResult.categories,
      coveragePercent: deepResult.coveragePercent,
      capabilityPercent: deepResult.capabilityPercent,
      unavailableTools: deepResult.unavailableTools,
      skipReasons: deepResult.hostBridge,
    } : { state: 'NOT_TESTED', reason: 'Run with --deep to fork the real driver and enumerate the model-facing catalog.' },
    history: history ? historicalToolNames(repoRoot) : { state: 'NOT_TESTED' },
    tools,
    v2Tools: v2Tools.map((tool) => ({ name: tool.name, tier: tool.tier, description: tool.description })),
    mcpTools,
    lanes: Object.fromEntries(Object.entries(caps.lanes).map(([lane, entry]) => [lane, {
      available: entry.available, tools: entry.tools.length, reason: entry.reason,
    }])),
    notes: [
      'A registered tool is not proof of a working integration.',
      'deep mode reflects this host at this moment; Windows-only tools are unavailable on non-Windows hosts.',
      'Credential boundaries are marked by lane; no credentials are inspected.',
      'Historical counts are unique declarations found in git history, not runtime registrations.',
      'No Windows acceptance has been performed from this environment.',
    ],
  };
  return inventory;
}

async function deepCatalog(repoRoot) {
  const { createDriverTools } = await import('../v5/codex-tools.js');
  const ALL_LANES = [
    'files', 'shell', 'shelltools', 'sys', 'power', 'web', 'research', 'jobs', 'flows', 'github',
    'channels', 'audit', 'learn', 'marketing', 're', 'trading', 'net', 'agent', 'desktop', 'screen',
    'computer', 'browser', 'mcp',
  ];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v6-inventory-'));
  try {
    const tools = await createDriverTools({
      workspace, grantedLanes: ALL_LANES, processAccess: true, browser: true, desktop: true,
    });
    const status = await tools.get('driver_status').run({});
    const result = status.result || status;
    return {
      registered: result.toolSources?.length || tools.size,
      available: result.toolParity.available,
      unavailable: result.toolParity.unavailable,
      categories: result.toolParity.categories,
      coveragePercent: result.toolParity.coveragePercent,
      capabilityPercent: result.toolParity.capabilityPercent,
      unavailableTools: result.toolParity.unavailableTools,
      hostBridge: result.hostBridge,
      catalog: [...tools.keys()].sort(),
      repoRoot,
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

export function renderInventoryMarkdown(inventory) {
  const c = inventory.counts;
  const lines = [];
  lines.push('# MAJIN V6 — Calculated Tool Inventory');
  lines.push('');
  lines.push(`Generated: ${inventory.generatedAt}  `);
  lines.push(`Platform: \`${inventory.platform}\``);
  lines.push('');
  lines.push('This file is generated from the repositories, not hand-written. A registration is not a working integration; read the availability columns.');
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push('| Measure | Value |');
  lines.push('| --- | --- |');
  for (const [key, value] of Object.entries(c)) lines.push(`| ${key} | ${value == null ? 'NOT_TESTED' : value} |`);
  lines.push('');
  lines.push(`Browser runtime: ${inventory.browserRuntime.available ? `available (${inventory.browserRuntime.binary || 'binary'})` : `unavailable — ${inventory.browserRuntime.reason}`}`);
  lines.push('');
  lines.push('## OpenCode driver (deep catalog)');
  lines.push('');
  if (inventory.deep?.registered == null) {
    lines.push(`NOT_TESTED — ${inventory.deep.reason}`);
  } else {
    lines.push(`Registered: **${inventory.deep.registered}**, available: **${inventory.deep.available}**, unavailable: **${inventory.deep.unavailable}**.`);
    lines.push('');
    lines.push('Unavailable tools carry a concrete reason in `inventory.json`; categories:');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(inventory.deep.categories, null, 2));
    lines.push('```');
  }
  lines.push('');
  lines.push('## V1 tools');
  lines.push('');
  lines.push('| Tool | Lane | Risk | Executable on this host | Unavailable reason |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const tool of inventory.tools) {
    lines.push(`| \`${tool.name}\` | ${tool.lane} | ${tool.risk || ''} | ${tool.executableOnHost ? 'yes' : 'no'} | ${tool.unavailableReason || ''} |`);
  }
  lines.push('');
  lines.push('## V2 builtins');
  lines.push('');
  lines.push('| Tool | Tier | Purpose |');
  lines.push('| --- | --- | --- |');
  for (const tool of inventory.v2Tools) lines.push(`| \`${tool.name}\` | ${tool.tier} | ${tool.description} |`);
  lines.push('');
  lines.push('## MCP surface exposed to OpenCode');
  lines.push('');
  lines.push('| Tool | Purpose |');
  lines.push('| --- | --- |');
  for (const tool of inventory.mcpTools) lines.push(`| \`${tool.name}\` | ${tool.description} |`);
  lines.push('');
  lines.push('## Lanes');
  lines.push('');
  lines.push('| Lane | Available | Loaded tools | Reason |');
  lines.push('| --- | --- | --- | --- |');
  for (const [lane, entry] of Object.entries(inventory.lanes)) {
    lines.push(`| ${lane} | ${entry.available ? 'yes' : 'no'} | ${entry.tools} | ${entry.reason || ''} |`);
  }
  lines.push('');
  lines.push('## Historical declarations');
  lines.push('');
  if (inventory.history?.state === 'NOT_TESTED') {
    lines.push('NOT_TESTED — rerun `majin-v6 inventory --history` to scan git history.');
  } else if (!inventory.history?.ok) {
    lines.push(`BLOCKED — ${inventory.history.error}`);
  } else {
    lines.push(`${inventory.history.method}: **${inventory.history.names.length}** unique names.`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const note of inventory.notes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

export { V1_LANES };
