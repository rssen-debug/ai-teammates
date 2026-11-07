/**
 * V2 command preflight (master brief sections 40 + 105).
 *
 * Scans a shell command BEFORE any execution and returns a tier:
 *   ok    - no danger indicators matched
 *   hold  - suspicious/destructive-ish: execution requires recorded consent
 *   no    - forbidden forever: never runs, regardless of consent (section 40 NO)
 *
 * Bypass vectors copied as lessons from public research (flag reordering,
 * shell wrappers, interpreter one-liners): the classifier normalizes flags,
 * unwraps sh/bash -c payload recursively, and screens interpreter payloads.
 */
/** procedural rm check: parse flags + targets, order-insensitive (flag-reorder bypass vector) */
function rmTargetsFsRoot(command) {
  for (const seg of command.split(/[;&|]+/)) {
    const m = seg.match(/(?:^|\s)rm\s+(.+)$/);
    if (!m) continue;
    let flags = '';
    const targets = [];
    for (const tok of m[1].trim().split(/\s+/)) {
      if (tok.startsWith('--')) {
        if (/recursive/.test(tok)) flags += 'r';
        if (/force/.test(tok)) flags += 'f';
        continue;
      }
      if (tok.startsWith('-') && tok.length > 1) { flags += tok.slice(1).replace(/[^a-zA-Z]/g, ''); continue; }
      targets.push(tok);
    }
    if (!(flags.includes('r') && flags.includes('f'))) continue;
    if (targets.some((t) => /^(\$HOME\/?\*?|\/?\*|~|~\/\*?|\/\/?)$/.test(t))) return true;
  }
  return false;
}

const ALWAYS_NO = [
  { pattern: /\b(format|mkfs|fdisk|diskpart\s+(clean|format))/i },
  { pattern: /\bdd\s+if=\S+\s+of=\/dev\// },
  { pattern: />\s*\/dev\/sd[a-z]/ },
  { pattern: /:\(\)\s*{\s*:\|:&\s*};:/ },
  { pattern: /\bgit\s+push\b.*\s--force(-with-lease)?\b.*\b(main|master)\b/ },
  { pattern: /git\s+push\s+--force\b\s*$|git\s+push\s+.*--force with-lease?\s*$|\bforce\s+push\b/ },
  { pattern: /\breg\s+delete\b/i },
  { pattern: /\bRemove-Item\b.*-Recurse.*-Force.*(\\\\[^ ]+|$Env:SystemDrive)\\?\s*$/i },
  { pattern: /\b(Set-ExecutionPolicy\s+Bypass|Invoke-Expression\s+.*IEX)/i },
];

const HOLD_PATTERNS = [
  { pattern: /\b(?:rmdir|rd|del|erase)\s+/i, reason: 'Windows deletion requires confirmation of the exact target' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*/ , reason: 'recursive delete of a scoped path — allowed with consent, scoped to target folder' },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-fd)/, reason: 'discards local changes — only with explicit confirmation of the exact target' },
  { pattern: /\bgit\s+checkout\s+--\s/, reason: 'git checkout -- discards working-tree changes for named files' },
  { pattern: /\bgit\s+stash\s+(drop|clear|pop)/, reason: 'removes stashed work permanently' },
  { pattern: /\b(npm|yarn|pnpm|bun)\s+audit\s+(fix\s+--force|--fix\s+--force)/, reason: 'forced audit fix rewrites dependency tree' },
  { pattern: /\bsudo\b/, reason: 'elevated privileges — consent + must be on the whitelist for V2 mode' },
  { pattern: /\b(bash|sh|zsh|pwsh|powershell)\s+(-c|-Command)\b/, reason: 'shell-wrapped command — payload is screened recursively below' },
  { pattern: /\b(curl|wget)\b.*(\||>)\s*\S*(sh|bash|pwsh|\bbin\b)/, reason: 'download piped into shell/executable' },
  { pattern: /\bcd\s+[\/~]?\.{0,2}\s*;\s*rm\b/, reason: 'chained cd;rm hides target' },
];

const FORBIDDEN_DOMAIN_HINT = /(eval|atob\s*\(|Buffer\.from\([^)]*base64)/;

/** unwrap one level of "-c" shell payloads so inner commands are screened too */
function* payloads(command) {
  yield command;
  const m = command.match(/^(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?)\s+(?:-.*\s+)*-(?:c|Command)\s+(['"`])([\s\S]*?)\1\s*$/);
  if (m) yield* payloads(m[2]);
  const interp = command.match(/^(?:python3?|node|perl|ruby)\s+-[^\s]*\s+(['"])([\s\S]*?)\1\s*$/);
  if (interp) yield `INTERPRETER_PAYLOAD:${interp[2]}`;
}

export function preflight(command) {
  if (typeof command !== 'string' || !command.trim()) return { tier: 'no', reason: 'empty command' };
  const seen = new Set();
  for (const payload of payloads(command)) {
    if (seen.has(payload)) continue;
    seen.add(payload);
    if (payload.startsWith('INTERPRETER_PAYLOAD:')) {
      const code = payload.slice('INTERPRETER_PAYLOAD:'.length);
      if (/\b(rm\s+-rf|shutil\.rmtree\s*\(\s*['"]\/|os\.system|child_process|subprocess\.run.*rm)\b/.test(code)) {
        return { tier: 'no', reason: 'interpreter one-liner hides destructive execution' };
      }
      continue;
    }
    if (!payload.startsWith('INTERPRETER_PAYLOAD:')) {
      if (rmTargetsFsRoot(payload)) return { tier: 'no', reason: 'recursive-force delete targeting a filesystem root/home — forbidden forever (brief 40)' };
    }
    for (const { pattern } of ALWAYS_NO) {
      if (pattern.test(payload)) return { tier: 'no', reason: `forbidden pattern matched: ${pattern}` };
    }
  }
  for (const { pattern, reason } of HOLD_PATTERNS) {
    for (const payload of payloads(command)) {
      if (!payload.startsWith('INTERPRETER_PAYLOAD:') && pattern.test(payload)) {
        return { tier: 'hold', reason };
      }
    }
  }
  if (FORBIDDEN_DOMAIN_HINT.test(command)) return { tier: 'hold', reason: 'obfuscation hint (eval/base64) — needs human eyes' };
  return { tier: 'ok', reason: '' };
}
