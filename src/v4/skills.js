/**
 * MAJIN V4 — skills.
 *
 * A skill is a *procedure the model is told about*, not a function the app
 * calls. That distinction is the difference between "MAJIN can search jobs" and
 * "MAJIN has a jobs button": a skill composes the general tools the owner
 * granted, and disappears the moment the tools it needs are not granted.
 *
 * On disk a skill is two files, readable by a human:
 *
 *   skills/<name>/skill.json   { name, title, summary, requires: [lane...],
 *                                tools?: [name...], prefers?: [name...],
 *                                experimental?: bool }
 *
 * `tools` are REQUIRED: without them the procedure cannot be followed at all, so
 * the skill is withheld. `prefers` are LOSSES, not blockers: the procedure still
 * works without them, and the prompt says which are missing so the model can be
 * honest about the degraded path instead of pretending.
 *   skills/<name>/SKILL.md     the procedure, in the owner's language
 *
 * Loading rules, all enforced here:
 *   - a skill whose required lanes are not granted is NOT offered to the model
 *     (a procedure naming tools the agent cannot call is a trap)
 *   - a skill may narrow the tools it references; it can never widen access
 *   - a malformed skill is skipped and named, never half-loaded
 *   - the text is capped, so a hostile skill file cannot flood the context
 *
 * Nothing here executes anything. A skill changes what the model is told; the
 * tool runner still decides what may run.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SKILL_SCHEMA = 'majin.v4.skill/v1';
export const MAX_SKILL_CHARS = 4000;
export const MAX_SKILLS_IN_PROMPT = 6;

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillError';
    this.code = code;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Validate one skill directory. Returns {skill} or {error}. */
export function loadSkill(dir) {
  const manifest = readJson(path.join(dir, 'skill.json'));
  if (!manifest) return { error: 'skill.json is missing or not valid JSON' };
  if (manifest.schema !== SKILL_SCHEMA) return { error: `unknown schema: ${manifest.schema}` };
  if (typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) return { error: `invalid name: ${manifest.name}` };
  if (path.basename(dir) !== manifest.name) return { error: `directory "${path.basename(dir)}" does not match the name "${manifest.name}"` };
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) return { error: 'title is required' };
  if (!Array.isArray(manifest.requires)) return { error: 'requires must be an array of lanes' };

  let body = '';
  try {
    body = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return { error: 'SKILL.md is missing' };
  }
  if (!body.trim()) return { error: 'SKILL.md is empty' };
  const truncated = body.length > MAX_SKILL_CHARS;
  return {
    skill: {
      name: manifest.name,
      title: String(manifest.title).slice(0, 80),
      summary: String(manifest.summary || '').slice(0, 200),
      requires: manifest.requires.filter((l) => typeof l === 'string'),
      tools: Array.isArray(manifest.tools) ? manifest.tools.filter((t) => typeof t === 'string') : null,
      prefers: Array.isArray(manifest.prefers) ? manifest.prefers.filter((t) => typeof t === 'string') : [],
      experimental: manifest.experimental === true,
      // A learned skill carries its provenance, state and `avoid` list in the
      // same manifest. One loader serves both kinds; nothing here special-cases
      // them beyond passing the block through.
      learned: manifest.learned && typeof manifest.learned === 'object' ? manifest.learned : null,
      body: truncated ? `${body.slice(0, MAX_SKILL_CHARS)}\n[truncated]` : body,
      dir,
      truncated,
    },
  };
}

/** Every skill on disk, with per-skill errors kept rather than thrown. */
export function discoverSkills(rootDir) {
  const found = [];
  const errors = [];
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { skills: found, errors };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const { skill, error } = loadSkill(path.join(rootDir, entry.name));
    if (error) errors.push({ name: entry.name, error });
    else found.push(skill);
  }
  return { skills: found, errors };
}

/**
 * Skills the model may be told about right now.
 *
 * @param {object} o
 * @param {object[]} o.skills      discovered skills
 * @param {string[]} o.grantedLanes lanes the owner granted
 * @param {string[]} [o.availableTools] tool names actually registered
 * @param {number} [o.limit]
 */
export function usableSkills({
  skills = [],
  grantedLanes = [],
  availableTools = null,
  limit = MAX_SKILLS_IN_PROMPT,
  // A hand-written skill marked `experimental` is withheld on purpose: the owner
  // has not vouched for it. A LEARNED skill instead carries an explicit state
  // (EXPERIMENTAL / VERIFIED / REUSABLE / STALE), and that state is rendered to
  // the model verbatim, so it is offered with its trust level stated rather than
  // hidden. Nothing about the hand-written rule changes.
  includeExperimental = false,
} = {}) {
  const granted = new Set(grantedLanes);
  const tools = availableTools ? new Set(availableTools) : null;
  const usable = [];
  const withheld = [];

  for (const skill of skills) {
    if (skill.experimental && !(includeExperimental && skill.learned)) {
      withheld.push({ name: skill.name, reason: 'experimental' });
      continue;
    }
    const missingLanes = skill.requires.filter((lane) => !granted.has(lane));
    if (missingLanes.length) {
      withheld.push({ name: skill.name, reason: `needs ${missingLanes.join(', ')}` });
      continue;
    }
    if (tools && skill.tools) {
      const missingTools = skill.tools.filter((t) => !tools.has(t));
      if (missingTools.length) {
        withheld.push({ name: skill.name, reason: `needs tool ${missingTools.join(', ')}` });
        continue;
      }
    }
    // `prefers` never blocks; it changes what the prompt admits is missing.
    const missingPreferred = tools && skill.prefers?.length
      ? skill.prefers.filter((t) => !tools.has(t))
      : [];
    usable.push({ ...skill, missingPreferred });
    if (usable.length >= limit) break;
  }
  return { usable, withheld };
}

/** Render the usable skills as a prompt section, or '' when there are none. */
export function renderSkills(usable = []) {
  if (!usable.length) return '';
  const blocks = usable.map((s) => {
    const gap = s.missingPreferred?.length
      ? `\n\nUnavailable on this host: ${s.missingPreferred.join(', ')}. Follow the procedure without them and say plainly what you could not do.`
      : '';
    return `### ${s.title}\n${s.body.trim()}${gap}`;
  });
  return [
    '## Skills you can follow',
    'These are procedures the owner installed. Follow one when the request matches it.',
    'They use the tools in this request; never assume a tool that is not offered.',
    ...blocks,
  ].join('\n\n');
}

/** List skills for the phone: what is installed and what each one needs. */
export function describeSkills({ skills = [], errors = [], grantedLanes = [], availableTools = null } = {}) {
  const { usable, withheld } = usableSkills({ skills, grantedLanes, availableTools });
  const usableNames = new Set(usable.map((s) => s.name));
  const withheldMap = Object.fromEntries(withheld.map((w) => [w.name, w.reason]));
  return {
    installed: skills.map((s) => ({
      name: s.name,
      title: s.title,
      summary: s.summary,
      requires: s.requires,
      ready: usableNames.has(s.name),
      ...(usable.find((u) => u.name === s.name)?.missingPreferred?.length
        ? { degraded: usable.find((u) => u.name === s.name).missingPreferred }
        : {}),
      ...(withheldMap[s.name] ? { blockedBy: withheldMap[s.name] } : {}),
    })),
    errors,
    ready: [...usableNames],
  };
}
