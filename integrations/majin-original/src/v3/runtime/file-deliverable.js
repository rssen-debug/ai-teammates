import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Goal } from '../../v2/runtime/goal.js';
import { runVerifier } from '../../v2/runtime/verifiers.js';
import { assertV3NodeSupported } from '../platform/runtime.js';

export const V3_FILE_LIMIT = 1_000_000;
export const V3_FILE_ACCEPTANCE_ID = 'artifact-written-and-verified';

const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_FILENAME_CHARS = /[\\/:<>"|?*\u0000-\u001f]/;

export class V3InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'V3InputError';
    this.code = 'INVALID_INPUT';
  }
}

function validateInput({ objective, fileName, content, workspaceDir }) {
  if (typeof objective !== 'string' || !objective.trim() || objective.length > 2_000) {
    throw new V3InputError('objective must be a non-empty string of at most 2000 characters');
  }
  if (typeof fileName !== 'string' || !fileName || fileName.length > 160
      || fileName === '.' || fileName === '..' || fileName.startsWith('.')
      || fileName.endsWith('.') || fileName.endsWith(' ')
      || INVALID_FILENAME_CHARS.test(fileName) || RESERVED_WINDOWS_NAME.test(fileName)) {
    throw new V3InputError('fileName must be a simple, visible filename without path separators or reserved characters');
  }
  if (typeof content !== 'string') throw new V3InputError('content must be a string');
  if (Buffer.byteLength(content, 'utf8') > V3_FILE_LIMIT) {
    throw new V3InputError(`content exceeds the ${V3_FILE_LIMIT}-byte limit`);
  }
  if (typeof workspaceDir !== 'string' || !workspaceDir.trim()) {
    throw new V3InputError('an explicit workspaceDir is required');
  }
}

function failureCode(error) {
  if (error?.code === 'EEXIST') return 'FILE_EXISTS';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'PERMISSION_DENIED';
  if (error?.code === 'ENOSPC') return 'DISK_FULL';
  return 'EXECUTION_FAILED';
}

/**
 * Small V3 vertical slice: request -> existing V2 durable Goal -> one
 * create-only workspace write -> existing V2 file verifier -> verified receipt.
 * This is intentionally a deterministic local demo, not an LLM or desktop
 * claim. It never overwrites an existing file and never invokes a shell.
 */
export async function runV3FileDeliverable({ objective, fileName, content, workspaceDir } = {}) {
  assertV3NodeSupported();
  validateInput({ objective, fileName, content, workspaceDir });

  const requestedRoot = path.resolve(workspaceDir);
  fs.mkdirSync(requestedRoot, { recursive: true });
  const root = fs.realpathSync(requestedRoot);
  const target = path.join(root, fileName);
  const stateDir = path.join(root, '.majin', 'v3', 'goals');
  const expectedHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const goal = new Goal({
    objective: objective.trim(),
    acceptance: [{ id: V3_FILE_ACCEPTANCE_ID, description: `Create and verify ${fileName}` }],
    risk: 'low',
    permissions: ['workspace.file:create', 'workspace.file:verify'],
    budgets: { toolCalls: 1, maxFileBytes: V3_FILE_LIMIT },
  });
  const checkpoint = () => goal.save(stateDir);
  const resultBase = () => ({
    goal: goal.toJSON(),
    artifact: { name: fileName, path: target },
  });

  try {
    checkpoint();
    goal.transition('PLANNING', 'deterministic single-file task');
    checkpoint();
    goal.transition('READY', 'create-only workspace write selected');
    checkpoint();
    goal.transition('RUNNING', 'executing workspace.file:create');
    checkpoint();

    // A leaf-only filename plus wx gives a create-only capability: no path
    // traversal, symlinked parent traversal, shell, or accidental overwrite.
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const receipt = goal.addReceipt({
      action: 'workspace.file.create',
      target: fileName,
      result: 'success',
      evidence: { bytes: Buffer.byteLength(content, 'utf8') },
      acceptanceId: V3_FILE_ACCEPTANCE_ID,
    });
    checkpoint();

    goal.transition('VERIFYING', 'checking created artifact with the V2 file verifier');
    checkpoint();
    const verification = await runVerifier('file', {
      path: target,
      minBytes: Buffer.byteLength(content, 'utf8'),
      hash: expectedHash,
    });

    if (!verification.verified) {
      goal.addReceipt({
        action: 'verification.file',
        target: fileName,
        result: 'failure',
        evidence: verification.error || null,
        errorClass: verification.error?.cls || 'VERIFICATION_FAILURE',
        acceptanceId: V3_FILE_ACCEPTANCE_ID,
      });
      goal.transition('FAILED', 'artifact verification failed');
      checkpoint();
      return {
        ok: false,
        ...resultBase(),
        error: { code: 'VERIFICATION_FAILED', message: verification.error?.message || 'file verification failed' },
      };
    }

    goal.verifyReceipt(receipt.id, {
      ...verification.evidence,
      verifier: 'v2.file',
      expectedSha256: expectedHash,
    });
    checkpoint();
    goal.complete();
    checkpoint();

    return {
      ok: true,
      ...resultBase(),
      evidence: {
        kind: verification.evidence.kind,
        bytes: verification.evidence.bytes,
        sha256: verification.evidence.sha256,
      },
    };
  } catch (error) {
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(goal.state)) {
      try {
        goal.transition('FAILED', failureCode(error));
        checkpoint();
      } catch {
        // Keep the original failure. A failed checkpoint is not reported as
        // durable success; a caller can inspect the returned state honestly.
      }
    }
    return {
      ok: false,
      ...resultBase(),
      error: { code: failureCode(error), message: String(error?.message || error) },
    };
  }
}
