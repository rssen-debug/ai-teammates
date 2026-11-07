/**
 * Conservative completion proof for an explicitly requested single-file Node ESM CLI.
 *
 * Do NOT execute generated code in the MAJIN host process. A success verdict
 * requires BOTH the existing static artifact contract AND two fresh, different
 * CLI invocations inside an already-cached, isolated Docker image. If Docker
 * is unavailable or either probe fails, return null (NOT VERIFIED).
 *
 * This intentionally does not apply to arbitrary scripts, multi-file projects,
 * browser tasks, edits, or untrusted symlinks.
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { explicitTarget, inspectRequestedArtifact } from './goal-artifact.js';

export function verifyIsolatedNodeCli(goal, workspace, { run = spawnSync, nonce = randomBytes(10).toString('hex') } = {}) {
  const request = String(goal || '');
  if (!/\bCLI\b/i.test(request) ||
      !/\brespond\s*\(\s*message\s*\)/i.test(request) ||
      !/\bprocess\.argv\b/i.test(request) ||
      !/\b(?:different|argument|arguments|input|runtime)\b/i.test(request)) return null;

  const target = explicitTarget(request, workspace);
  if (!target || !/\.mjs$/i.test(target.name)) return null;
  const staticCheck = inspectRequestedArtifact(request, workspace);
  if (!staticCheck?.ok) return null;

  try {
    const st = fs.lstatSync(target.path);
    // Never bind a symlink or a non-regular source into the verifier.
    if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > 1024 * 1024) return null;
  } catch { return null; }

  const outputs = [];
  const markers = ['MAJIN_PROBE_A_' + nonce, 'MAJIN_PROBE_B_' + nonce];
  for (const marker of markers) {
    // --pull=never: no unexpected large downloads or online dependency.
    // Mount ONLY the requested file read-only, never the entire workspace.
    const args = [
      'run', '--rm', '--pull=never', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=32', '--memory=256m', '--user=10001:10001',
      '--mount', 'type=bind,source=' + target.path + ',target=/work/agent.mjs,readonly',
      '-w', '/work', 'node:22-alpine',
      'node', '/work/agent.mjs', marker,
    ];
    let result;
    try {
      result = run('docker', args, {
        encoding: 'utf8', timeout: 8000, maxBuffer: 65536, windowsHide: true,
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '' },
      });
    } catch { return null; }
    if (result?.error || result?.status !== 0) return null;
    const output = String(result.stdout || '').trim();
    if (!output.includes(marker)) return null;
    outputs.push(output);
  }
  if (outputs.length !== 2 || outputs[0] === outputs[1]) return null;

  return {
    ok: true,
    target: target.name,
    text: 'Verified ' + target.name + ': JavaScript syntax, exported responder, CLI entrypoint, ' +
      'and two different fresh arguments in read-only, no-network Docker. The single-file task is complete.',
    stopReason: 'verified_isolated_cli',
  };
}
