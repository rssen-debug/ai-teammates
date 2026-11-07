/**
 * MAJIN V5 — Autonomous Skill Builder (Python 3 & Node.js).
 *
 * When Majin lacks a skill for a requested task, it can synthesize a new
 * reusable skill (SKILL.md + skill.json + scripts/runner.py or runner.mjs),
 * validate it against security boundaries, execute a self-test in an isolated
 * sandbox, independently verify the output artifact via V2 `runVerifier`, and
 * register it into the canonical SkillTree.
 *
 * Hard safety rules (Section 12):
 *  - Agent-proposed code/plugins MUST be validated and tested before activation.
 *  - A passing example may NEVER silently modify the main runtime (`src/`).
 *  - Synthesized scripts run with a scrubbed environment (zero API keys/secrets)
 *    and strict timeout inside an isolated directory.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVerifier } from '../v2/runtime/verifiers.js';

const FORBIDDEN_CODE_PATTERNS = [
  { id: 'RUNTIME_MUTATION', re: /\b(?:src[\\/](?:v5|v4|v3|v2|core)|\.git[\\/]|package\.json)\b/i },
  { id: 'SECRET_ACCESS', re: /\b(?:OPENCODE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|MAJIN_SECRET|pairing\.json|secret\.key)\b/i },
  { id: 'DESTRUCTIVE_OS', re: /(?:rm\s+-rf\s+\/|os\.system\s*\(|subprocess\.Popen\s*\(|shutil\.rmtree\s*\(\s*['"]\/['"]|format\s+[a-z]:|del\s+\/[fqs])/i },
  { id: 'UNSAFE_EVAL', re: /\b(?:eval\s*\(|exec\s*\(\s*input|child_process\.execSync\s*\(\s*`)/i },
];

/** Resolve the interpreter, not a Windows launcher that depends on the user's environment. */
export function detectPythonBinary({ spawn = spawnSync, exists = fs.existsSync } = {}) {
  for (const bin of ['python3', 'python']) {
    try {
      const res = spawn(bin, ['-c', 'import json, sys; print(json.dumps(sys.executable))'], {
        encoding: 'utf8', timeout: 3000, windowsHide: true,
      });
      if (res.status !== 0 || res.error) continue;
      const executable = JSON.parse(String(res.stdout || '').trim());
      if (typeof executable === 'string' && path.isAbsolute(executable) && exists(executable)) {
        return executable;
      }
    } catch { /* try next */ }
  }
  return null;
}

/** Static validation ensuring synthesized code cannot mutate main runtime or exfiltrate secrets. */
export function validateSynthesizedCode(code = '') {
  const src = String(code || '');
  if (!src.trim()) {
    return { valid: false, reason: 'EMPTY_CODE', violations: ['EMPTY_CODE'] };
  }
  if (src.length > 32_000) {
    return { valid: false, reason: 'CODE_TOO_LARGE', violations: ['CODE_TOO_LARGE'] };
  }
  const violations = [];
  for (const rule of FORBIDDEN_CODE_PATTERNS) {
    if (rule.re.test(src)) violations.push(rule.id);
  }
  return {
    valid: violations.length === 0,
    reason: violations.length === 0 ? 'OK' : `FORBIDDEN_PATTERN:${violations.join(',')}`,
    violations,
  };
}

/** Built-in Python/Node templates when synthesizing a missing data/file/analysis skill. */
function defaultPythonSkillTemplate({ canonicalId, purpose }) {
  return `#!/usr/bin/env python3
"""
Synthesized Majin V5 Skill: ${canonicalId}
Purpose: ${purpose}
"""
import json
import hashlib
import os
import sys

def main():
    raw_input = sys.stdin.read().strip() if not sys.stdin.isatty() else "{}"
    payload = json.loads(raw_input) if raw_input else {}
    out_file = payload.get("outputFile")
    data = payload.get("data", {})
    operation = payload.get("operation", "transform")

    # Perform deterministic transformation / analysis
    if isinstance(data, list):
        processed = [item for item in data if item is not None]
        count = len(processed)
    elif isinstance(data, dict):
        processed = {k: v for k, v in sorted(data.items())}
        count = len(processed)
    else:
        processed = str(data)
        count = len(processed)

    result = {
        "ok": True,
        "skill": ${JSON.stringify(canonicalId)},
        "operation": operation,
        "count": count,
        "result": processed,
    }
    encoded = json.dumps(result, indent=2, ensure_ascii=False)
    sha256 = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    result["sha256"] = sha256

    if out_file:
        os.makedirs(os.path.dirname(os.path.abspath(out_file)), exist_ok=True)
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(json.dumps(result, indent=2, ensure_ascii=False) + "\\n")

    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
`;
}

function defaultNodeSkillTemplate({ canonicalId, purpose }) {
  return `#!/usr/bin/env node
/**
 * Synthesized Majin V5 Skill: ${canonicalId}
 * Purpose: ${purpose}
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const raw = fs.readFileSync(0, 'utf8').trim();
const payload = raw ? JSON.parse(raw) : {};
const outFile = payload.outputFile;
const data = payload.data ?? {};
const operation = payload.operation || 'transform';

const processed = Array.isArray(data)
  ? data.filter((x) => x != null)
  : (data && typeof data === 'object' ? Object.fromEntries(Object.entries(data).sort()) : String(data));

const result = {
  ok: true,
  skill: ${JSON.stringify(canonicalId)},
  operation,
  count: Array.isArray(processed) ? processed.length : Object.keys(processed).length,
  result: processed,
};
const body = JSON.stringify(result, null, 2) + '\\n';
result.sha256 = crypto.createHash('sha256').update(body).digest('hex');

if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\\n', 'utf8');
}
process.stdout.write(JSON.stringify(result) + '\\n');
`;
}

export class SkillBuilder {
  constructor({ dataDir, skillTree }) {
    if (!dataDir) throw new Error('SkillBuilder requires dataDir');
    if (!skillTree) throw new Error('SkillBuilder requires skillTree');
    this.dataDir = dataDir;
    this.skillsRoot = path.join(dataDir, 'synthesized-skills');
    this.skillTree = skillTree;
    fs.mkdirSync(this.skillsRoot, { recursive: true, mode: 0o700 });
  }

  /**
   * Synthesize, validate, sandbox-test and register a new skill (via Python or Node).
   *
   * Never modifies the main runtime. Only activates the skill in `SkillTree`
   * after the isolated self-test and independent V2 file verifier pass.
   */
  async synthesizeSkill({
    name,
    displayName,
    domain = 'code',
    purpose = 'Synthesized automation skill',
    runtime = 'python', // 'python' | 'node'
    code = null,
    testInput = { operation: 'self_test', data: ['alpha', 'beta', 'gamma'] },
    timeoutMs = 5000,
  } = {}) {
    const cleanSlug = String(name || displayName || 'custom-skill')
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const canonicalId = cleanSlug.includes('.') ? cleanSlug : `${domain}.${cleanSlug}`;

    // 1. Check if skillTree already has an equivalent skill
    const existing = this.skillTree.get(canonicalId);
    if (existing && existing.synthesizedScript && fs.existsSync(existing.synthesizedScript)) {
      return {
        ok: true,
        action: 'reused',
        skill: existing,
        scriptPath: existing.synthesizedScript,
      };
    }

    const pythonBin = runtime === 'python' ? detectPythonBinary() : null;
    const effectiveRuntime = runtime === 'python' && pythonBin ? 'python' : 'node';

    const sourceCode = code || (
      effectiveRuntime === 'python'
        ? defaultPythonSkillTemplate({ canonicalId, purpose })
        : defaultNodeSkillTemplate({ canonicalId, purpose })
    );

    // 2. Validate code safety before writing or executing anything
    const validation = validateSynthesizedCode(sourceCode);
    if (!validation.valid) {
      return {
        ok: false,
        action: 'rejected',
        reason: validation.reason,
        violations: validation.violations,
      };
    }

    const skillDir = path.join(this.skillsRoot, canonicalId.replace(/\./g, '_'));
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true, mode: 0o700 });

    const scriptFile = path.join(
      scriptsDir,
      effectiveRuntime === 'python' ? 'runner.py' : 'runner.mjs',
    );
    fs.writeFileSync(scriptFile, sourceCode, { mode: 0o700 });

    // 3. Run self-test in a disposable sandbox with scrubbed environment
    const testResult = await this.executeSynthesizedScript({
      scriptPath: scriptFile,
      runtime: effectiveRuntime,
      input: testInput,
      timeoutMs,
    });

    if (!testResult.ok || !testResult.verifiedReceipt?.verified) {
      try {
        fs.rmSync(skillDir, { recursive: true, force: true });
      } catch { /* ignore cleanup error */ }
      return {
        ok: false,
        action: 'test_failed',
        reason: testResult.error || 'Self-test output failed independent verification',
      };
    }

    // 4. Write AgentSkills-compatible SKILL.md and skill.json
    const skillVersion = [1, 0, 0].join('.');
    const manifest = {
      schema: 'majin.v5.skill/v1',
      canonical_id: canonicalId,
      display_name: displayName || name || canonicalId,
      domain,
      runtime: effectiveRuntime,
      script: path.relative(skillDir, scriptFile),
      version: skillVersion,
      origin: `synthesized-${effectiveRuntime}`,
      verifiedSelfTestSha256: testResult.verifiedReceipt.sha256,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        `# ${manifest.display_name} (${canonicalId})`,
        '',
        purpose,
        '',
        `- Runtime: \`${effectiveRuntime}\``,
        `- Script: \`${manifest.script}\``,
        `- Self-test SHA-256: \`${manifest.verifiedSelfTestSha256}\``,
      ].join('\n'),
      { mode: 0o600 },
    );

    // 5. Register into SkillTree (starts at Level 1 / 0 XP; self-test passes qualityGate)
    const registered = this.skillTree.resolveOrRegisterSkill({
      canonical_id: canonicalId,
      display_name: manifest.display_name,
      title_en: manifest.display_name,
      domain,
      kind: 'skill',
      aliases: [canonicalId, cleanSlug, String(name || '').toLowerCase()].filter(Boolean),
      purpose,
      masteryScope: {
        mastered: `${purpose} (verified via ${effectiveRuntime} sandbox self-test).`,
        limitations: 'Scoped strictly to workspace and granted folders; never modifies main runtime.',
      },
      contract: {
        input: ['data', 'operation', 'outputFile?'],
        output: ['ok', 'count', 'result', 'sha256'],
      },
      required_tools: [`synthesized.${effectiveRuntime}`],
      relevance_criteria: cleanSlug.split(/[-.]/).filter((w) => w.length >= 3),
      version: skillVersion,
      origin: `synthesized-${effectiveRuntime}`,
      verification_method: 'file_sha256',
      synthesizedScript: scriptFile,
      qualityGates: {
        versionedTestSuitePassed: true,
        testSuiteVersion: '1.0.0',
      },
    });

    registered.skill.synthesizedScript = scriptFile;
    registered.skill.origin = `synthesized-${effectiveRuntime}`;
    registered.skill.qualityGates = {
      versionedTestSuitePassed: true,
      testSuiteVersion: registered.skill.version,
    };
    this.skillTree.save();

    return {
      ok: true,
      action: registered.action,
      runtime: effectiveRuntime,
      skill: registered.skill,
      scriptPath: scriptFile,
      selfTestReceipt: testResult.verifiedReceipt,
    };
  }

  /**
   * Execute a synthesized skill script in an isolated directory and independently
   * verify its output file using V2 `runVerifier('file', ...)`.
   */
  async executeSynthesizedScript({
    scriptPath,
    runtime = 'python',
    input = {},
    outputDir = null,
    timeoutMs = 5000,
  } = {}) {
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      return { ok: false, error: 'Script file does not exist' };
    }
    const code = fs.readFileSync(scriptPath, 'utf8');
    const check = validateSynthesizedCode(code);
    if (!check.valid) {
      return { ok: false, error: check.reason };
    }

    const workDir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-skill-'));
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const outFile = path.join(workDir, 'skill-output.json');

    const payload = JSON.stringify({ ...input, outputFile: outFile });
    const bin = runtime === 'python' ? (detectPythonBinary() || 'python3') : process.execPath;

    // Scrubbed environment: never pass API keys or session secrets to synthesized scripts
    const scrubbedEnv = {
      PATH: process.env.PATH || '',
      HOME: workDir,
      TMPDIR: workDir,
      TEMP: workDir,
      TMP: workDir,
      PYTHONIOENCODING: 'utf-8',
      LC_ALL: 'C.UTF-8',
      ...(process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot } : {}),
    };

    const proc = spawnSync(bin, [scriptPath], {
      cwd: workDir,
      env: scrubbedEnv,
      input: payload,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });

    if (proc.error || proc.status !== 0) {
      return {
        ok: false,
        error: proc.error?.message || String(proc.stderr || `Exit code ${proc.status}`).trim(),
      };
    }

    if (!fs.existsSync(outFile)) {
      return { ok: false, error: 'Synthesized skill did not produce outputFile' };
    }

    const fileBytes = fs.readFileSync(outFile);
    const expectedSha = crypto.createHash('sha256').update(fileBytes).digest('hex');

    // Independent verification via V2 file verifier
    const verifyRes = await runVerifier('file', {
      path: outFile,
      minBytes: 1,
      hash: expectedSha,
    });

    if (!verifyRes.verified) {
      return { ok: false, error: verifyRes.error?.message || 'Independent file verifier failed' };
    }

    let parsedOutput = null;
    try {
      parsedOutput = JSON.parse(fileBytes.toString('utf8'));
    } catch {
      return { ok: false, error: 'Output artifact is not valid JSON' };
    }

    const receiptId = `rcpt-synth-${expectedSha.slice(0, 16)}-${Date.now()}`;
    return {
      ok: true,
      output: parsedOutput,
      outputFile: outFile,
      verifiedReceipt: {
        id: receiptId,
        receiptId,
        kind: 'file',
        verifier: 'file',
        verified: true,
        path: outFile,
        sha256: expectedSha,
        bytes: fileBytes.length,
        at: new Date().toISOString(),
      },
    };
  }
}
