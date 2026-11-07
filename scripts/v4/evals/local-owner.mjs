// Explicit local-owner evaluation mode. Never creates/rotates credentials or
// sessions, and never sends local session material to a non-loopback origin.
import fs from 'node:fs';
import path from 'node:path';
import { hmac } from '../../../src/v4/auth.js';

export function existingLocalOwnerCookie({ home, base }) {
  const url = new URL(base);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || !['http:','https:'].includes(url.protocol)) throw Error('Local-owner credentials can only be used against a loopback host');
  const root = path.join(path.resolve(home), 'v4');
  const secret = fs.readFileSync(path.join(root, 'secret.key'), 'utf8').trim();
  const data = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'));
  const session = Object.values(data.sessions || {}).find(s => typeof s.id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(s.id) && s.expiresAt > Date.now());
  if (!session || !secret) throw Error('An existing unexpired paired session is required; no pairing was created');
  return `majin_v4=${session.id}.${hmac(secret, session.id)}`;
}
