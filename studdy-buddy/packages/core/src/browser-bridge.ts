import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NetAcadPageContext, SelectionContext } from '@studdy/shared';

/**
 * Local bridge for the browser extension.
 *
 * The extension talks to the Electron app over a loopback WebSocket. Three things
 * matter for security:
 *
 *  1. Identity: the extension must present the shared token that was generated
 *     when the student connected it. Tokens are compared in constant time.
 *  2. The bridge is bound to 127.0.0.1 only, and only accepts messages whose
 *     shape validates against an allow-list of message kinds.
 *  3. Page content is accepted from **any site the student allows**, because the
 *     product must work for Canvas, Moodle, a university portal, docs, or a PDF
 *     viewer — not only NetAcad. The allow-list is therefore a decision the
 *     student makes in the app (`siteAllowList`), not a hardcoded vendor list.
 *     With no allow-list configured the bridge fails closed.
 *
 * This module holds the *pure* parts (auth, policy, message parsing) so they are
 * testable without opening a socket. `bridge-server.ts` owns the socket.
 */

export interface BridgeMessage {
  type: 'hello' | 'page-context' | 'curriculum' | 'selection' | 'quiz-observation' | 'ping' | 'site-request';
  token?: string;
  payload?: unknown;
  sentAt?: string;
}

export interface BridgeAuthResult {
  ok: boolean;
  reason: string;
}

export function generateBridgeToken(random: (n: number) => Buffer = randomBytes): string {
  return random(24).toString('hex');
}

/** Constant-time token comparison. */
export function verifyToken(provided: string | undefined, expected: string): BridgeAuthResult {
  if (!expected) return { ok: false, reason: 'Ingen token är konfigurerad i appen.' };
  if (!provided) return { ok: false, reason: 'Anslutningen saknade token.' };
  const a = Buffer.from(createHash('sha256').update(provided).digest());
  const b = Buffer.from(createHash('sha256').update(expected).digest());
  if (a.length !== b.length) return { ok: false, reason: 'Token matchar inte.' };
  return timingSafeEqual(a, b) ? { ok: true, reason: 'ok' } : { ok: false, reason: 'Token matchar inte.' };
}

const ALLOWED_TYPES = new Set(['hello', 'page-context', 'curriculum', 'selection', 'quiz-observation', 'ping', 'site-request']);

export function parseBridgeMessage(raw: string): { message: BridgeMessage | null; error: string | null } {
  if (raw.length > 2_000_000) return { message: null, error: 'Meddelandet är för stort.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { message: null, error: 'Ogiltig JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { message: null, error: 'Meddelandet måste vara ett objekt.' };
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
    return { message: null, error: `Otillåten meddelandetyp: ${String(type)}` };
  }
  return {
    message: {
      type: type as BridgeMessage['type'],
      token: typeof obj.token === 'string' ? obj.token : undefined,
      payload: obj.payload,
      sentAt: typeof obj.sentAt === 'string' ? obj.sentAt : undefined,
    },
    error: null,
  };
}

/**
 * Domains we recognise by default, purely so the settings UI can pre-fill them.
 * They are NOT the security boundary: `isAllowedPageUrl` takes the student's own
 * allow-list. Adding a site is a one-line change in the UI, not a code change.
 */
export const KNOWN_STUDY_SITES = [
  'netacad.com',
  'cisco.com',
  'skillsforall.com',
  'canvas.instructure.com',
  'instructure.com',
  'moodle.org',
  'moodlecloud.com',
  'blackboard.com',
  'itslearning.com',
  'coursera.org',
  'edx.org',
  'udemy.com',
  'khanacademy.org',
  'kth.se',
  'su.se',
  'du.se',
  'his.se',
];

/**
 * Normalises one allow-list entry to a hostname: strips scheme, path, port and
 * a leading `*.` or `www.`. Returns null for anything unusable.
 */
export function normalizeSiteRule(rule: string): string | null {
  const trimmed = rule.trim().toLowerCase();
  if (!trimmed) return null;
  let host = trimmed;
  try {
    if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    return null;
  }
  host = host.split('/')[0] ?? '';
  host = host.split(':')[0] ?? '';
  host = host.replace(/^\*?\./, '').replace(/^www\./, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return null;
  return host;
}

/**
 * True when `url` is https and its host equals, or is a subdomain of, one of the
 * student's allowed sites.
 *
 * `netacad.com.evil.io` and `evil.netacad.com.attacker.net` are rejected because
 * we compare the *suffix of the hostname*, not a substring of the whole URL.
 */
export function isAllowedPageUrl(url: string, allowList: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  for (const rule of allowList) {
    const allowed = normalizeSiteRule(rule);
    if (!allowed) continue;
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

export function validatePageContext(
  payload: unknown,
  allowList: string[],
): { value: NetAcadPageContext | null; error: string | null } {
  if (typeof payload !== 'object' || payload === null) return { value: null, error: 'Saknar payload.' };
  const root = payload as Record<string, unknown>;
  // The extension sends `{ schemaVersion, page, snapshot }`; older builds sent the
  // page fields at the top level. Accept both rather than silently dropping data.
  const nested = root.snapshot ?? root.page;
  const p = (typeof nested === 'object' && nested !== null ? nested : root) as Record<string, unknown>;
  if (typeof p.url !== 'string') return { value: null, error: 'Saknar url.' };
  if (allowList.length === 0) return { value: null, error: 'Ingen sajt är tillåten i appen ännu.' };
  if (!isAllowedPageUrl(p.url, allowList)) {
    return { value: null, error: 'Sidan finns inte i listan över tillåtna studiesajter.' };
  }
  const headingPath = Array.isArray(p.headingPath) ? p.headingPath.filter((h): h is string => typeof h === 'string').slice(0, 12) : [];
  return {
    value: {
      url: p.url,
      courseName: typeof p.courseName === 'string' ? p.courseName.slice(0, 200) : null,
      title: typeof p.title === 'string' ? p.title.slice(0, 200) : undefined,
      siteName: typeof p.siteName === 'string' ? p.siteName.slice(0, 80) : null,
      headingPath,
      currentNodeId: typeof p.currentNodeId === 'string' ? p.currentNodeId : null,
      platformCompletedVisible: typeof p.platformCompletedVisible === 'boolean' ? p.platformCompletedVisible : null,
      detectedAt: typeof p.detectedAt === 'string' ? p.detectedAt : new Date().toISOString(),
    },
    error: null,
  };
}

export function validateSelection(
  payload: unknown,
  allowList: string[],
): { value: SelectionContext | null; error: string | null } {
  if (typeof payload !== 'object' || payload === null) return { value: null, error: 'Saknar payload.' };
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== 'string' || typeof p.url !== 'string') return { value: null, error: 'Saknar text eller url.' };
  if (allowList.length > 0 && !isAllowedPageUrl(p.url, allowList)) return { value: null, error: 'Sidan är inte godkänd.' };
  const text = p.text.trim();
  if (!text) return { value: null, error: 'Tom markering.' };
  const rect = typeof p.rect === 'object' && p.rect !== null ? (p.rect as Record<string, unknown>) : null;
  return {
    value: {
      text: text.slice(0, 12_000),
      url: p.url,
      rect: rect && typeof rect.x === 'number' && typeof rect.y === 'number' && typeof rect.width === 'number' && typeof rect.height === 'number'
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null,
    },
    error: null,
  };
}

/**
 * A site the student asked to allow, from the extension popup.
 *
 * This is a *request*, not a grant: the app decides, records it, and tells the
 * extension the resulting list. We only refuse input that could not be a
 * hostname at all.
 */
export function validateSiteRequest(payload: unknown): { host: string | null; error: string | null } {
  if (typeof payload !== 'object' || payload === null) return { host: null, error: 'Saknar payload.' };
  const p = payload as Record<string, unknown>;
  if (typeof p.host !== 'string') return { host: null, error: 'Saknar host.' };
  const host = normalizeSiteRule(p.host);
  if (!host) return { host: null, error: 'Ogiltig sajt.' };
  return { host, error: null };
}
