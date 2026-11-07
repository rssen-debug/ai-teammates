/**
 * MAJIN V6 — read-only Gmail integration for application verification.
 *
 * Authentication is OAuth2 refresh-token based and owner-supplied. No
 * credentials are read from the repository and no token is ever logged.
 * The initial scope is gmail.readonly: this module can read messages, never
 * send, delete or modify them, and it never follows a verification link.
 */
import fs from 'node:fs';
import path from 'node:path';
import { maskEmail } from './redact.js';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const MARKETING = [
  /\bnewsletter\b/i, /\bunsubscribe\b/i, /\bwebinar\b/i, /\boffer\b/i, /\bdiscount\b/i,
  /\bjob alert\b/i, /\bweekly digest\b/i, /\brecommended jobs\b/i, /\bmarknadsf/i,
];
const VERIFY = [
  /\bverify (your )?(e-?mail|address)\b/i, /\bconfirm (your )?(e-?mail|address)\b/i,
  /\bactivate (your )?account\b/i, /\bverifiera (din )?(e-?post|mejl|adress)\b/i,
  /\bbekr[aä]fta (din )?(e-?post|mejl|adress)\b/i, /\bcomplete your application\b/i,  // input vocabulary, never rendered
];
const CONFIRM = [
  /\bapplication (has been |was )?(received|submitted|registered)\b/i,
  /\bthank you for (your )?appl(y|ication)\b/i, /\bwe('| ha)ve received your application\b/i,
  /\btack f[oö]r din ans[oö]kan\b/i, /\bans[oö]kan (har )?(mottagits|registrerats)\b/i,  // input vocabulary, never rendered
  /\byour application is complete\b/i,
];

export function loadGmailCredentials({ file = null, env = process.env } = {}) {
  const candidateFile = file || env.MAJIN_V6_GMAIL_CREDENTIALS_FILE || null;
  let source = null;
  let raw = null;
  if (candidateFile && fs.existsSync(candidateFile)) {
    try {
      const stat = fs.statSync(candidateFile);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        return { ok: false, credentials: null, error: { code: 'GMAIL_CREDENTIALS_PERMISSIONS', reason: 'Credentials file must not be readable by group/others (chmod 600)' } };
      }
      raw = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
      source = 'file';
    } catch (error) {
      return { ok: false, credentials: null, error: { code: 'GMAIL_CREDENTIALS_UNREADABLE', reason: String(error.message || error).slice(0, 200) } };
    }
  } else if (env.MAJIN_V6_GMAIL_CLIENT_ID && env.MAJIN_V6_GMAIL_CLIENT_SECRET && env.MAJIN_V6_GMAIL_REFRESH_TOKEN) {
    raw = {
      clientId: env.MAJIN_V6_GMAIL_CLIENT_ID,
      clientSecret: env.MAJIN_V6_GMAIL_CLIENT_SECRET,
      refreshToken: env.MAJIN_V6_GMAIL_REFRESH_TOKEN,
      account: env.MAJIN_V6_GMAIL_ACCOUNT || null,
    };
    source = 'env';
  }
  if (!raw) {
    return {
      ok: false, credentials: null,
      error: { code: 'GMAIL_NOT_CONFIGURED', reason: 'Gmail is not configured. Supply an owner-only credentials file or OAuth refresh token. No Gmail access is inferred.' },
    };
  }
  if (raw.scope && raw.scope !== GMAIL_READONLY_SCOPE) {
    return { ok: false, credentials: null, error: { code: 'GMAIL_SCOPE_UNSAFE', reason: `Only ${GMAIL_READONLY_SCOPE} is accepted` } };
  }
  for (const key of ['clientId', 'clientSecret', 'refreshToken']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) {
      return { ok: false, credentials: null, error: { code: 'GMAIL_CREDENTIALS_INCOMPLETE', reason: `Missing ${key}` } };
    }
  }
  return {
    ok: true,
    source,
    credentials: {
      clientId: raw.clientId, clientSecret: raw.clientSecret, refreshToken: raw.refreshToken,
      account: raw.account || null, scope: GMAIL_READONLY_SCOPE, file: candidateFile ? path.resolve(candidateFile) : null,
    },
    error: null,
  };
}

function header(payload, name) {
  const headers = payload?.headers || [];
  const found = headers.find((item) => String(item.name).toLowerCase() === name.toLowerCase());
  return found?.value || '';
}

function decodeBase64Url(data) {
  if (!data) return '';
  try { return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; }
}

export function extractPlainText(payload, { maxChars = 20000 } = {}) {
  if (!payload) return '';
  const chunks = [];
  const walk = (part) => {
    if (!part || chunks.join('').length >= maxChars) return;
    if (part.mimeType === 'text/plain' && part.body?.data) chunks.push(decodeBase64Url(part.body.data));
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  return chunks.join('\n').replace(/\s+/g, ' ').slice(0, maxChars);
}

/** Pure and fixture-tested. Never assumes a marketing blast is a verification. */
export function classifyApplicationEmail({ subject = '', from = '', snippet = '', text = '' } = {}) {
  const haystack = `${subject}\n${snippet}\n${text}`;
  const marketing = MARKETING.filter((pattern) => pattern.test(haystack)).map((pattern) => pattern.source);
  const verifyHits = VERIFY.filter((pattern) => pattern.test(haystack));
  const confirmHits = CONFIRM.filter((pattern) => pattern.test(haystack));
  const senderDomain = String(from).match(/@([A-Za-z0-9.-]+)>?$/)?.[1]?.toLowerCase() || null;
  const looksTransactional = Boolean(senderDomain) && !/(mailchimp|sendgrid|hubspot|mailgun|constantcontact)/i.test(senderDomain);
  if (marketing.length && !confirmHits.length && !verifyHits.length) {
    return { isApplicationEmail: false, kind: 'marketing', confidence: 0, reasons: marketing, senderDomain };
  }
  if (!verifyHits.length && !confirmHits.length) {
    return { isApplicationEmail: false, kind: 'other', confidence: 0, reasons: ['no application-verification or confirmation language'], senderDomain };
  }
  if (marketing.length) {
    return { isApplicationEmail: false, kind: 'ambiguous', confidence: 0.2, reasons: ['marketing language present alongside application language'], senderDomain };
  }
  const kind = confirmHits.length >= verifyHits.length ? 'confirmation' : 'verification';
  return {
    isApplicationEmail: true,
    kind,
    confidence: Math.min(0.95, 0.5 + 0.15 * (kind === 'confirmation' ? confirmHits.length : verifyHits.length)),
    reasons: [...(kind === 'confirmation' ? confirmHits : verifyHits)].map((pattern) => pattern.source),
    senderDomain,
    transactionalSender: looksTransactional,
  };
}

export function extractReference(text = '') {
  const value = String(text);
  // Keywords are case-insensitive, but a reference is upper-case + digits, so
  // the two passes are separate rather than one loose /i capture.
  const keyword = /\b(reference|referens(?:nummer)?|application(?:\s+(?:id|number|no\.?))?|case(?:\s+id)?|ärendenummer)\b/i.exec(value);  // input vocabulary, never rendered
  if (keyword) {
    const rest = value.slice(keyword.index + keyword[0].length, keyword.index + keyword[0].length + 80);
    const candidate = /\b([A-Z0-9][A-Z0-9-]{4,30})\b/.exec(rest);
    if (candidate && /\d/.test(candidate[1])) return candidate[1];
  }
  const prefixed = /\b([A-Z]{2,8}-\d{3,12}(?:-[A-Z0-9]{2,12})?)\b/.exec(value);
  if (prefixed) return prefixed[1];
  const generic = /\b(?=[A-Z0-9-]{6,32}\b)(?=[A-Z0-9-]*\d)([A-Z0-9-]{6,32})\b/.exec(value);
  return generic ? generic[1] : null;
}

export function extractLinks(text = '') {
  const links = String(text).match(/https:\/\/[^\s"'<>)]+/gi) || [];
  return [...new Set(links)].slice(0, 10);
}

/** Match an email to one application using employer + role signals. */
export function matchEmailToApplication(email = {}, applications = []) {
  const haystack = `${email.subject || ''} ${email.snippet || ''} ${email.text || ''}`.toLowerCase();
  let best = null;
  for (const app of applications) {
    const company = String(app.job?.company || '').toLowerCase().replace(/\b(ab|hb)\b/g, '').trim();
    const title = String(app.job?.title || '').toLowerCase();
    const reasons = [];
    let score = 0;
    if (company && company.length >= 3 && haystack.includes(company)) { score += 3; reasons.push('employer-name'); }
    const titleTokens = title.split(/[^a-z0-9åäö]+/i).filter((token) => token.length >= 4);  // input vocabulary, never rendered
    const titleHits = titleTokens.filter((token) => haystack.includes(token));
    if (titleHits.length >= Math.min(2, titleTokens.length)) { score += 2; reasons.push('role-title'); }
    if (email.reference && String(app.job?.siteId || '') && String(email.reference).includes(String(app.job.siteId))) { score += 2; reasons.push('listing-reference'); }
    if (score > (best?.score || 0)) best = { applicationId: app.id, score, reasons };
  }
  return best;
}

export class GmailClient {
  constructor({ credentials, fetchImpl = globalThis.fetch, clock = Date.now, log = null } = {}) {
    if (!credentials) throw new Error('GmailClient requires credentials');
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.log = log;
    this.account = credentials.account || null;
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }

  async accessToken() {
    if (this.cachedToken && this.tokenExpiresAt > this.clock() + 30000) return this.cachedToken;
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: 'refresh_token',
    });
    let response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body, signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw Object.assign(new Error('Could not reach Google OAuth'), { code: 'GMAIL_NETWORK', retryable: true });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Gmail OAuth failed (HTTP ${response.status})`), {
        code: response.status === 400 || response.status === 401 ? 'GMAIL_AUTH_FAILED' : 'GMAIL_OAUTH_HTTP',
        retryable: response.status >= 500,
      });
    }
    const json = await response.json();
    if (!json.access_token) throw Object.assign(new Error('Gmail OAuth returned no access token'), { code: 'GMAIL_AUTH_FAILED', retryable: false });
    this.cachedToken = json.access_token;
    this.tokenExpiresAt = this.clock() + Math.max(60, Number(json.expires_in) || 3600) * 1000;
    return this.cachedToken;
  }

  async #request(pathAndQuery) {
    const token = await this.accessToken();
    const response = await this.fetchImpl(`${API}/${pathAndQuery}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Gmail API HTTP ${response.status}`), {
        code: response.status === 401 ? 'GMAIL_AUTH_FAILED' : response.status === 429 ? 'GMAIL_RATE_LIMITED' : 'GMAIL_HTTP',
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return response.json();
  }

  async searchMessages({ query, maxResults = 10 }) {
    const bounded = Math.max(1, Math.min(50, Number(maxResults) || 10));
    const json = await this.#request(`messages?q=${encodeURIComponent(query)}&maxResults=${bounded}`);
    return (json.messages || []).map((item) => item.id);
  }

  async getMessage(id) {
    const json = await this.#request(`messages/${encodeURIComponent(id)}?format=full`);
    const payload = json.payload;
    return {
      id: json.id,
      threadId: json.threadId || null,
      subject: header(payload, 'Subject'),
      from: header(payload, 'From'),
      date: header(payload, 'Date'),
      receivedAt: json.internalDate ? new Date(Number(json.internalDate)).toISOString() : new Date(this.clock()).toISOString(),
      snippet: json.snippet || '',
      text: extractPlainText(payload),
      labelIds: json.labelIds || [],
    };
  }

  /**
   * Read-only search for job emails. Returns at most one matched candidate
   * email: a confirmation wins over a verification request.
   */
  async findApplicationEmails({ company, title, sinceDays = 30 } = {}) {
    const since = Math.max(1, Math.min(90, Number(sinceDays) || 30));
    const terms = ['application', 'ansökan', 'applied', 'verification'];  // input vocabulary, never rendered
    const companyToken = String(company || '').replace(/["(){}:]/g, ' ').trim();
    if (companyToken) terms.push(`"${companyToken}"`);
    const query = `newer_than:${since}d (${terms.join(' OR ')})`;
    const ids = await this.searchMessages({ query, maxResults: 20 });
    let scanned = 0;
    let best = null;
    for (const id of ids) {
      let message;
      try { message = await this.getMessage(id); } catch (error) {
        if (error.code === 'GMAIL_AUTH_FAILED') throw error;
        continue;
      }
      scanned += 1;
      const classification = classifyApplicationEmail(message);
      if (!classification.isApplicationEmail) continue;
      const reference = extractReference(`${message.subject} ${message.text}`);
      const match = matchEmailToApplication({ ...message, reference }, [{ id: 'candidate', job: { company, title } }]);
      if (!match) continue;
      const candidate = {
        messageId: message.id, kind: classification.kind, confidence: classification.confidence,
        receivedAt: message.receivedAt, senderDomain: classification.senderDomain,
        reference, reasons: [...match.reasons, ...classification.reasons].slice(0, 6),
      };
      if (!best || (candidate.kind === 'confirmation' && best.kind !== 'confirmation')
        || (candidate.kind === best.kind && candidate.confidence > best.confidence)) best = candidate;
    }
    this.log?.append('gmail.checked', {
      taskId: null, scanned, matched: Boolean(best), kind: best?.kind || null,
      account: this.account ? maskEmail(this.account) : null,
    });
    return { scanned, matched: best, account: this.account };
  }
}
