/**
 * MAJIN V5 — Files, Streaming Uploads, External Portal Upload & Owner Access (Section 8).
 *
 * Reuses V4's `UploadStore`, `safeUploadName`, `sniffType`, `extractText`,
 * `OwnerMode`, and `allowsPath`.
 *
 * Key V5 upgrades:
 *  - Configurable upload size limit (documents V4's 6 MB default and provides
 *    configurable `maxUploadBytes`, default 25 MB, plus `saveFromStream` for
 *    streaming large binary uploads without base64 memory bloat).
 *  - External portal upload (`uploadToPortal`) with verified byte count and
 *    SHA-256 receipt.
 *  - Persistent Owner Mode permissions so routine tasks do not get stuck in
 *    repeated approval prompts, with instant revocation and emergency stop.
 *  - Strict separation between full user file access (`ownerFileAccess`) and
 *    OS Administrator elevation (`osAdminElevated`).
 *  - Untrusted data guard: pages, uploaded files and imported skills can NEVER
 *    escalate permissions.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  UploadStore,
  UploadError,
  UPLOAD_TYPES,
  MAX_UPLOAD_BYTES as V4_DEFAULT_UPLOAD_BYTES,
  safeUploadName,
  sniffType,
} from '../v4/uploads.js';
import { extractText } from '../v4/extract.js';
import { OwnerMode, GRANTABLE_LANES } from '../v4/owner-mode.js';
import { checkPath } from '../v4/path-access.js';

export const V5_DEFAULT_UPLOAD_BYTES = Number(
  process.env.MAJIN_V5_MAX_UPLOAD_BYTES || 25 * 1024 * 1024,
);

/** Detect whether the current process actually has OS Administrator / root privileges. */
export function detectOsAdminPrivileges() {
  if (process.platform === 'win32') {
    return false; // Never claim Windows Administrator unless verified by net session / token elevation
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export class FileAndAccessController {
  constructor({
    dataDir,
    workspaceDir = null,
    maxUploadBytes = V5_DEFAULT_UPLOAD_BYTES,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!dataDir) {
      throw new Error('FileAndAccessController requires dataDir');
    }
    this.dataDir = dataDir;
    this.workspaceDir = workspaceDir || path.join(dataDir, 'workspace');
    this.maxUploadBytes = maxUploadBytes;
    this.fetchImpl = fetchImpl;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.workspaceDir, { recursive: true, mode: 0o700 });

    this.uploadStore = new UploadStore({
      dir: this.workspaceDir,
      maxBytes: this.maxUploadBytes,
    });
    this.ownerMode = new OwnerMode({
      file: path.join(dataDir, 'owner-mode.json'),
    });
    this.stopRequested = false;
    this.activeControllers = new Set();
  }

  /** Update configurable upload size limit at runtime. */
  setMaxUploadBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 1024 || n > 500 * 1024 * 1024) {
      throw new UploadError('INVALID_INPUT', 'maxUploadBytes must be between 1 KB and 500 MB');
    }
    this.maxUploadBytes = Math.floor(n);
    this.uploadStore.maxBytes = this.maxUploadBytes;
    return {
      v4DefaultBytes: V4_DEFAULT_UPLOAD_BYTES,
      maxUploadBytes: this.maxUploadBytes,
      maxUploadMB: Number((this.maxUploadBytes / (1024 * 1024)).toFixed(2)),
    };
  }

  /** Save a base64 / JSON upload and extract text when applicable (PDF, DOCX, TXT, MD, CSV, JSON). */
  saveUpload({ name, type, data } = {}) {
    const saved = this.uploadStore.save({ name, type, data });
    const fullPath = path.join(this.workspaceDir, saved.name);
    let extractedText = null;
    try {
      const buf = fs.readFileSync(fullPath);
      const ex = extractText(buf, { fileName: saved.name });
      extractedText = ex?.text || null;
    } catch {
      extractedText = null;
    }
    return {
      ...saved,
      path: fullPath,
      extractedText,
      maxUploadBytes: this.maxUploadBytes,
    };
  }

  /**
   * Stream-based upload handler for larger files (avoids base64 memory amplification).
   * Enforces byte limit on the fly while hashing with SHA-256.
   */
  async saveStreamUpload({ name, type, readableStream }) {
    const safe = safeUploadName(name);
    const declared = String(type || '').toLowerCase();
    const entry = UPLOAD_TYPES[declared];
    if (!entry) {
      throw new UploadError('UNSUPPORTED_TYPE', `type "${declared || 'unknown'}" is not accepted for upload`);
    }

    const tempPath = path.join(this.workspaceDir, `.upload-${process.pid}-${Date.now()}.part`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let headerChunk = Buffer.alloc(0);

    const out = fs.createWriteStream(tempPath, { mode: 0o600, flags: 'wx' });
    try {
      for await (const chunk of readableStream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > this.maxUploadBytes) {
          throw new UploadError(
            'TOO_LARGE',
            `stream upload exceeds configured limit of ${Math.floor(this.maxUploadBytes / 1024)} kB`,
          );
        }
        if (headerChunk.length < 16) {
          headerChunk = Buffer.concat([headerChunk, buf.subarray(0, 16 - headerChunk.length)]);
        }
        hash.update(buf);
        if (!out.write(buf)) {
          await new Promise((r) => out.once('drain', r));
        }
      }
      await new Promise((resolve, reject) => {
        out.end((err) => (err ? reject(err) : resolve()));
      });

      if (bytes === 0) {
        throw new UploadError('INVALID_INPUT', 'stream upload is empty');
      }

      const detected = sniffType(headerChunk);
      if (declared === 'application/pdf' && detected !== 'application/pdf') {
        throw new UploadError('UNSUPPORTED_TYPE', 'streamed file does not have PDF magic bytes');
      }

      const targetPath = path.join(this.workspaceDir, safe);
      fs.renameSync(tempPath, targetPath);
      const sha256 = hash.digest('hex');

      let extractedText = null;
      if (bytes <= 15 * 1024 * 1024) {
        try {
          const ex = extractText(fs.readFileSync(targetPath), { fileName: safe });
          extractedText = ex?.text || null;
        } catch { /* optional extraction */ }
      }

      return {
        name: safe,
        path: targetPath,
        type: declared,
        kind: entry.kind,
        bytes,
        sha256,
        streamed: true,
        extractedText,
      };
    } catch (err) {
      try {
        out.destroy();
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch { /* ignore */ }
      throw err;
    }
  }

  /** Read and extract text from a file in workspace or an owner-granted folder. */
  readAuthorizedDocument(filePath) {
    const resolved = path.resolve(filePath);
    const inWorkspace = resolved.startsWith(path.resolve(this.workspaceDir) + path.sep)
      || resolved === path.resolve(this.workspaceDir);
    const grantedFolders = this.ownerMode.folders();
    const check = inWorkspace
      ? { allowed: true, abs: resolved }
      : checkPath(resolved, { workspace: this.workspaceDir, folders: grantedFolders });

    if (!check.allowed) {
      const err = new Error(`Access denied to path outside workspace and granted folders: ${filePath}`);
      err.code = 'PERMISSION_DENIED';
      throw err;
    }

    const buf = fs.readFileSync(resolved);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    let extracted = { text: '', confidence: 1 };
    try {
      extracted = extractText(buf, { fileName: path.basename(resolved) });
    } catch {
      extracted = { text: '', confidence: 0 };
    }
    return {
      ok: true,
      path: resolved,
      name: path.basename(resolved),
      bytes: buf.length,
      sha256,
      text: extracted.text,
      confidence: extracted.confidence ?? 1,
      receipt: {
        id: `rcpt-docread-${sha256.slice(0, 16)}-${Date.now()}`,
        receiptId: `rcpt-docread-${sha256.slice(0, 16)}-${Date.now()}`,
        kind: 'file',
        verifier: 'file',
        verified: true,
        path: resolved,
        sha256,
        bytes: buf.length,
        at: new Date().toISOString(),
      },
    };
  }

  /**
   * Upload a verified local file (e.g. a CV) to an external portal (test portal or job portal)
   * and verify the portal's receipt (matching SHA-256 and byte count).
   */
  async uploadToPortal({
    filePath,
    portalUrl,
    fieldName = 'cv',
    extraFields = {},
    signal = null,
  } = {}) {
    const doc = this.readAuthorizedDocument(filePath);
    const buf = fs.readFileSync(doc.path);

    const payload = {
      fieldName,
      fileName: doc.name,
      bytes: buf.length,
      sha256: doc.sha256,
      dataBase64: buf.toString('base64'),
      fields: extraFields,
    };

    const res = await this.fetchImpl(portalUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `Portal upload failed with HTTP ${res.status}`,
      };
    }

    const body = await res.json();
    const shaMatched = body?.receivedSha256 === doc.sha256 || body?.sha256 === doc.sha256;
    const bytesMatched = Number(body?.receivedBytes ?? body?.bytes) === buf.length;
    const verified = Boolean(body?.ok !== false && shaMatched && bytesMatched);
    const receiptId = String(body?.receiptId || `rcpt-upload-${doc.sha256.slice(0, 12)}-${Date.now()}`);

    return {
      ok: verified,
      fileName: doc.name,
      bytes: buf.length,
      sha256: doc.sha256,
      portalResponse: body,
      verifiedReceipt: {
        id: receiptId,
        receiptId,
        kind: 'http',
        verifier: 'http',
        verified,
        sha256: doc.sha256,
        bytes: buf.length,
        portalUrl,
        at: new Date().toISOString(),
      },
    };
  }

  /**
   * Enable Owner Mode with broad access (`full` grants all user-level lanes and
   * specified folders, persisted on disk so routine tasks never re-prompt).
   * Explicitly separates user-level Owner Mode from OS Administrator rights.
   */
  enableOwnerMode({ lanes = [...GRANTABLE_LANES], folders = [], browserOrigins = [] } = {}) {
    this.stopRequested = false;
    this.ownerMode.grant({ lanes, folders, browserOrigins });
    return this.describeAccessState();
  }

  /** Persist exact origins where MAJIN's browser may perform writes/submits. */
  grantBrowserOrigins(origins) {
    this.stopRequested = false;
    this.ownerMode.grantBrowserOrigins(origins);
    return this.describeAccessState();
  }

  /** Revoke browser write origins immediately; omitted input clears only those origins. */
  revokeBrowserOrigins(origins = null) {
    this.ownerMode.revokeBrowserOrigins(origins);
    return this.describeAccessState();
  }

  /** Revoke all or selected permissions immediately. */
  revokePermissions({ lanes = null, folder = null, browserOrigins = null } = {}) {
    if (!lanes && !folder && !browserOrigins) {
      this.ownerMode.revoke();
    } else {
      this.ownerMode.revoke({
        lanes: Array.isArray(lanes) ? lanes : null,
        folders: folder ? [folder] : null,
        browserOrigins: Array.isArray(browserOrigins) ? browserOrigins : null,
      });
    }
    return this.describeAccessState();
  }

  /** Instant emergency stop: aborts all registered active controllers immediately. */
  triggerEmergencyStop() {
    this.stopRequested = true;
    let abortedCount = 0;
    for (const ctrl of this.activeControllers) {
      try {
        ctrl.abort(new Error('OWNER_EMERGENCY_STOP'));
        abortedCount += 1;
      } catch { /* ignore */ }
    }
    this.activeControllers.clear();
    return {
      stopped: true,
      abortedOperations: abortedCount,
      at: new Date().toISOString(),
    };
  }

  /**
   * Untrusted data guard: pages, uploaded files, and imported skills are DATA
   * and can NEVER escalate permissions or grant lanes/folders.
   */
  assertUntrustedDataCannotEscalate(source = {}) {
    const kind = String(source.sourceKind || 'data');
    if (['webpage', 'uploaded_file', 'imported_skill', 'job_ad', 'external_api'].includes(kind)) {
      if (source.requestedLanes?.length || source.requestedFolders?.length || source.requestedBrowserOrigins?.length || source.enableOwnerMode) {
        const err = new Error(`Untrusted data source (${kind}) attempted to escalate permissions.`);
        err.code = 'UNTRUSTED_PERMISSION_ESCALATION_BLOCKED';
        throw err;
      }
    }
    return { allowed: true, escalated: false };
  }

  describeAccessState() {
    const view = this.ownerMode.view();
    return {
      ownerModeActive: view.enabled,
      ownerFileAccess: view.lanes.includes('files'),
      osAdminElevated: detectOsAdminPrivileges(),
      adminSeparationNote: 'Full file access in Owner Mode operates strictly within the OS user account and is distinct from OS Administrator/UAC elevation.',
      grantedLanes: view.lanes,
      grantedFolders: view.folders,
      browserWriteOrigins: view.browserOrigins || [],
      effectiveBrowserWriteOrigins: view.effectiveBrowserOrigins || [],
      stopRequested: this.stopRequested,
      uploadLimits: {
        v4DefaultBytes: V4_DEFAULT_UPLOAD_BYTES,
        v5ConfiguredMaxBytes: this.maxUploadBytes,
        v5ConfiguredMaxMB: Number((this.maxUploadBytes / (1024 * 1024)).toFixed(2)),
        streamingSupported: true,
      },
    };
  }
}
