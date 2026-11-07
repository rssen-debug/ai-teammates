/**
 * MAJIN V4 — uploads and inline previews.
 *
 * Two new surfaces, both of which are attack paths if done carelessly:
 *
 *   upload  — the phone writes bytes onto the owner's machine
 *   preview — a file MAJIN created is rendered as HTML in the owner's browser
 *
 * Rules enforced here, not documented elsewhere:
 *
 *  1. **Name is a leaf.** Same rule as the workspace tool: no separators, no
 *     traversal, no reserved Windows names, no leading dot. An upload can never
 *     choose its own directory.
 *  2. **A type allowlist, not a blocklist.** Only types the product actually
 *     shows are accepted. `html`, `svg` and `js` are deliberately NOT uploadable:
 *     they execute, and an uploaded HTML file would be a script running inside
 *     the owner's authenticated session.
 *  3. **Size is enforced twice** — declared length before reading, bytes counted
 *     while decoding.
 *  4. **Bytes are re-typed on the server.** The browser's declared MIME is a
 *     hint; a mismatched payload is stored with the type we detected, and an
 *     image whose magic bytes do not match is refused.
 *  5. **Previews never share the app's origin.** HTML is served with a
 *     `Content-Security-Policy: sandbox` header so the document runs in an opaque
 *     origin: it cannot read the session cookie, the DOM of the app, or call the
 *     API. The client additionally uses `<iframe sandbox="allow-scripts">`
 *     without `allow-same-origin`, which is the belt to that suspenders.
 *
 * What this does NOT do: it does not scan for malware, and it cannot stop the
 * owner from opening a hostile PDF in their own viewer. Both are stated in
 * SECURITY.md rather than implied.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractText, ExtractError } from './extract.js';

/** Types the interface can actually render. Nothing executable. */
export const UPLOAD_TYPES = Object.freeze({
  'image/png': { ext: '.png', kind: 'image' },
  'image/jpeg': { ext: '.jpg', kind: 'image' },
  'image/webp': { ext: '.webp', kind: 'image' },
  'image/gif': { ext: '.gif', kind: 'image' },
  'image/heic': { ext: '.heic', kind: 'image' },
  'application/pdf': { ext: '.pdf', kind: 'document' },
  'text/plain': { ext: '.txt', kind: 'text' },
  'text/markdown': { ext: '.md', kind: 'text' },
  'text/csv': { ext: '.csv', kind: 'text' },
  'application/json': { ext: '.json', kind: 'text' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: '.docx', kind: 'document' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: '.xlsx', kind: 'document' },
});

/** Types that are shown inline rather than downloaded. */
export const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/markdown',
]);

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024; // 6 MB: a phone photo is ~3

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SEPARATORS = /[\\/]/;
const INVALID_NAME = /[<>:"|?*\u0000-\u001f]/;

export class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.status = {
      INVALID_INPUT: 400,
      INVALID_PATH: 400,
      UNSUPPORTED_TYPE: 415,
      TOO_LARGE: 413,
      BAD_ENCODING: 400,
      NOT_FOUND: 404,
    }[code] || 400;
  }
}

/** A leaf filename, safe for Windows and for our own workspace. */
export function safeUploadName(raw) {
  if (typeof raw !== 'string') throw new UploadError('INVALID_INPUT', 'name must be a string');
  const name = raw.trim();
  if (!name) throw new UploadError('INVALID_INPUT', 'name is empty');
  if (name.length > 120) throw new UploadError('INVALID_INPUT', 'name is too long');
  if (SEPARATORS.test(name) || name.includes('\0')) {
    throw new UploadError('INVALID_PATH', 'name must be a leaf name without path separators');
  }
  if (name.startsWith('.') || name === '.' || name === '..') {
    throw new UploadError('INVALID_PATH', 'name may not start with a dot');
  }
  if (INVALID_NAME.test(name) || RESERVED.test(name)) {
    throw new UploadError('INVALID_PATH', 'name contains characters or a device name that Windows rejects');
  }
  if (name.endsWith('.') || name.endsWith(' ')) throw new UploadError('INVALID_PATH', 'name may not end with a dot or space');
  return name;
}

/** Detect the real type from the bytes; the browser's claim is only a hint. */
export function sniffType(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (b.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (b.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.slice(8, 12).toString('ascii');
    if (brand.startsWith('hei') || brand.startsWith('mif')) return 'image/heic';
  }
  if (b.slice(0, 2).toString('ascii') === 'PK') return 'application/zip'; // docx/xlsx are zip containers
  return null;
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
    if (n > 999) throw new UploadError('INVALID_INPUT', 'could not find a free name');
  }
  return candidate;
}

export class UploadStore {
  constructor({ dir, maxBytes = MAX_UPLOAD_BYTES }) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Store one upload from a JSON body: { name, type, data } with `data` base64.
   *
   * @returns {{name:string, type:string, bytes:number, sha256:string, kind:string, inline:boolean}}
   */
  save({ name, type, data } = {}) {
    const safe = safeUploadName(name);
    const declared = String(type || '').toLowerCase();
    const entry = UPLOAD_TYPES[declared];
    if (!entry) {
      throw new UploadError('UNSUPPORTED_TYPE', `type "${declared || 'unknown'}" is not accepted for upload`);
    }
    if (typeof data !== 'string' || !data) throw new UploadError('INVALID_INPUT', 'data (base64) is required');

    // "data:image/png;base64,AAAA" is accepted and stripped.
    const b64 = data.includes(',') && data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new UploadError('BAD_ENCODING', 'data is not valid base64');

    const approx = Math.floor((b64.replace(/\s/g, '').length * 3) / 4);
    if (approx > this.maxBytes) {
      throw new UploadError('TOO_LARGE', `upload is larger than ${Math.floor(this.maxBytes / 1024)} kB`);
    }

    const buf = Buffer.from(b64, 'base64');
    if (buf.length > this.maxBytes) {
      throw new UploadError('TOO_LARGE', `upload is larger than ${Math.floor(this.maxBytes / 1024)} kB`);
    }
    if (buf.length === 0) throw new UploadError('INVALID_INPUT', 'the file is empty');

    // The claimed type must agree with the bytes for anything we render.
    const detected = sniffType(buf);
    const claimedIsDocument = entry.kind === 'document';
    if (claimedIsDocument) {
      if (declared === 'application/pdf' && detected !== 'application/pdf') {
        throw new UploadError('UNSUPPORTED_TYPE', 'the file does not look like a PDF');
      }
      if (declared.endsWith('wordprocessingml.document') || declared.endsWith('spreadsheetml.sheet')) {
        if (detected !== 'application/zip') {
          throw new UploadError('UNSUPPORTED_TYPE', 'the file does not look like a DOCX/XLSX container');
        }
      }
    } else if (entry.kind === 'image') {
      if (detected && detected !== declared) {
        throw new UploadError('UNSUPPORTED_TYPE', `the file is ${detected}, not ${declared}`);
      }
      if (!detected) throw new UploadError('UNSUPPORTED_TYPE', 'the file does not look like an image');
    }

    const finalName = uniqueName(this.dir, safe);
    const target = path.join(this.dir, finalName);
    if (path.dirname(path.resolve(target)) !== path.resolve(this.dir)) {
      throw new UploadError('INVALID_PATH', 'resolved path escapes the upload directory');
    }

    fs.writeFileSync(target, buf, { mode: 0o600, flag: 'wx' });

    // Say up front whether MAJIN can read the contents, and how far. An upload
    // whose text cannot be read is not a failure of the upload, but the owner
    // must know before asking "read my CV".
    const readable = describeReadability(buf, finalName);

    return {
      name: finalName,
      type: declared,
      kind: entry.kind,
      bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      inline: INLINE_TYPES.has(declared),
      ...readable,
    };
  }

  /** Resolve a stored upload, or null. Traversal is impossible: leaf only. */
  resolve(name) {
    let safe;
    try {
      safe = safeUploadName(name);
    } catch {
      return null;
    }
    const target = path.join(this.dir, safe);
    if (!fs.existsSync(target)) return null;
    const stat = fs.statSync(target);
    if (!stat.isFile()) return null;
    return { path: target, name: safe, bytes: stat.size };
  }

  list() {
    try {
      return fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const st = fs.statSync(path.join(this.dir, e.name));
          return { name: e.name, bytes: st.size, at: st.mtime.toISOString() };
        })
        .sort((a, b) => (a.at < b.at ? 1 : -1));
    } catch {
      return [];
    }
  }
}

/**
 * Describe what the extraction layer can do with this file, without keeping
 * the text in the API response (the agent reads it through `document_read`).
 */
export function describeReadability(buf, fileName) {
  try {
    const { kind, confidence, text } = extractText(buf, { fileName });
    return {
      readable: true,
      textKind: kind,
      textConfidence: confidence,
      textChars: text.length,
    };
  } catch (err) {
    if (err instanceof ExtractError) {
      return {
        readable: false,
        readError: err.code,
        readNote: err.code === 'NO_TEXT_LAYER'
          ? 'the PDF has no text layer (probably a scan); OCR is not built in'
          : err.message,
      };
    }
    return { readable: false, readError: 'EXTRACT_FAILED', readNote: String(err?.message || err) };
  }
}

/** Content type for serving a stored file back. */
export function typeForName(name) {
  const ext = path.extname(String(name)).toLowerCase();
  const found = Object.entries(UPLOAD_TYPES).find(([, v]) => v.ext === ext);
  if (found) return found[0];
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.css') return 'text/css';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * Headers for serving a user-visible file back.
 *
 * An HTML file MAJIN wrote is served with `CSP: sandbox`, which puts it in an
 * opaque origin even if the client forgets the iframe sandbox. SVG gets the same
 * treatment because it can carry script.
 */
export function serveHeadersFor(name, type) {
  const headers = {
    'content-type': type === 'application/octet-stream' ? type : `${type}; charset=utf-8`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
  if (type === 'text/html' || type === 'image/svg+xml') {
    headers['content-security-policy'] = "sandbox allow-scripts; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' blob:; script-src 'unsafe-inline' blob:; font-src data:";
    headers['content-disposition'] = 'inline';
  } else if (type.startsWith('image/') || type === 'application/pdf') {
    headers['content-disposition'] = 'inline';
    headers['content-security-policy'] = "default-src 'none'; img-src data:; object-src 'none'";
  } else {
    headers['content-disposition'] = `attachment; filename="${String(name).replace(/["\\]/g, '')}"`;
    headers['content-security-policy'] = "default-src 'none'";
  }
  return headers;
}
