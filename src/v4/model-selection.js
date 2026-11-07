/** One durable model choice for every V4 client. V1 credentials stay untouched. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { discoverModels, resolveRouteForModel } from './models.js';
import { HttpError } from './security.js';

const fileFor = (home) => path.join(home, 'v4', 'model-selection.json');
const fingerprint = (route) => createHash('sha256').update(JSON.stringify([route.providerName, route.kind, route.baseUrl, route.model])).digest('hex');

export function readModelSelection({ home, env = process.env }) {
  const file = fileFor(home);
  if (!fs.existsSync(file)) return { v: 1, version: 0, modelId: discoverModels({ home, env }).current, authorizedRoutes: [], persisted: false };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.v !== 1 || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.modelId !== 'string' || !Array.isArray(value.authorizedRoutes) || value.authorizedRoutes.some((r) => !/^[a-f0-9]{64}$/.test(r))) throw new Error('invalid');
    return { ...value, persisted: true };
  } catch { throw new HttpError(503, 'MODEL_SELECTION_INVALID', 'Saved model selection is unreadable. Restore it before changing models.'); }
}

export function publicModelSelection(options) {
  const { version, modelId, persisted, updatedAt } = readModelSelection(options);
  return { version, modelId, persisted, updatedAt: updatedAt || null };
}

export function assertModelBillingAuthorized({ home, env = process.env, modelId, base }) {
  const catalogue = discoverModels({ home, env });
  // Preserve the route explicitly configured by the owner. This is authorization
  // to use the existing route, NOT proof that its billing is free or included.
  if (modelId === catalogue.current) return;
  const route = resolveRouteForModel({ home, env, modelId, base });
  const selection = readModelSelection({ home, env });
  if (route && selection.authorizedRoutes.includes(fingerprint(route))) return;
  throw new HttpError(409, 'MODEL_COST_AUTHORIZATION_REQUIRED', 'Cost unknown — verify with provider. Explicit authorization is required before using this model route.');
}

export function selectCanonicalModel({ home, env = process.env, modelId, expectedVersion, authorizePotentialCost = false, base }) {
  const previous = readModelSelection({ home, env });
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) throw new HttpError(409, 'MODEL_SELECTION_CONFLICT', 'Model selection changed on another device. Refresh and choose again.');
  const catalogue = discoverModels({ home, env });
  const entry = catalogue.models.find((m) => m.id === modelId && m.configured);
  const route = resolveRouteForModel({ home, env, modelId, base });
  if (!entry || !route) throw new HttpError(400, 'MODEL_NOT_CONFIGURED', 'That model route is unavailable. Refresh the host catalogue.');
  const routeHash = fingerprint(route);
  const alreadyAuthorized = modelId === catalogue.current || previous.authorizedRoutes.includes(routeHash);
  if (!alreadyAuthorized && authorizePotentialCost !== true) throw new HttpError(409, 'MODEL_COST_AUTHORIZATION_REQUIRED', entry.billing?.label || 'Cost unknown — verify with provider');
  const next = { v: 1, version: previous.version + 1, modelId, updatedAt: new Date().toISOString(), authorizedRoutes: [...new Set([...previous.authorizedRoutes, routeHash])] };
  const file = fileFor(home), temp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return publicModelSelection({ home, env });
}
