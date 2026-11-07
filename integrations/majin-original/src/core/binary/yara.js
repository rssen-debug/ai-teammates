/**
 * MAJIN RE — mini-YARA.
 * Ett underlag av riktig YARA som väger 0 kB och kräver ingen native-modul:
 * textsträngar (ascii/wide/nocase), hexmönster med ??-wildcards och (aa|bb)-val,
 * regex, samt villkor med any/all/N of them, and/or/not och filesize.
 * Tillräckligt för att skriva egna detector-regler i agenten och köra dem direkt.
 */

export function parseRules(src) {
  const rules = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const m = /\brule\s+([A-Za-z_][\w]*)/.exec(src.slice(i));
    if (!m) break;
    const start = i + m.index;
    const open = src.indexOf('{', start + m[0].length);
    if (open < 0) break;
    let depth = 0;
    let end = -1;
    for (let p = open; p < len; p += 1) {
      if (src[p] === '{') depth += 1;
      else if (src[p] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = p;
          break;
        }
      }
    }
    if (end < 0) break;
    const tags = src.slice(start + m[0].length, open).trim();
    rules.push(compileRule(m[1], tags, src.slice(open + 1, end)));
    i = end + 1;
  }
  return rules;
}

function compileRule(name, tags, body) {
  const meta = parseMeta(section(body, 'meta'));
  const strings = parseStrings(section(body, 'strings'));
  const condition = section(body, 'condition').trim().replace(/;\s*$/, '');
  return { name, tags: tags.replace(/^:/, '').split(/\s+/).filter(Boolean), meta, strings, condition, ast: parseCondition(condition, strings) };
}

/** Klipp ut en regelsektion mellan två etiketter. */
function section(body, key) {
  const re = new RegExp(`(^|[}\\s])${key}\\s*:`, 'i');
  const m = re.exec(body);
  if (!m) return '';
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/\b(meta|strings|condition)\s*:/);
  return next < 0 ? rest : rest.slice(0, next);
}

function parseMeta(src) {
  const meta = {};
  for (const line of src.split('\n')) {
    const m = /(\w+)\s*=\s*(?:"([^"]*)"|(\d+)|(-?\d+)|true|false)/.exec(line);
    if (!m) continue;
    meta[m[1]] = m[2] !== undefined ? m[2] : Number(m[3] ?? m[4]);
  }
  return meta;
}

function parseStrings(src) {
  const out = [];
  const re = /\$([A-Za-z_]\w*)\s*=\s*(\{[^}]*\}|"[^"]*"|\/(?!\*)[^\/\n]+\/[is]*?)/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, raw] = m;
    if (raw.startsWith('{')) out.push({ name, kind: 'hex', pattern: compileHex(raw.slice(1, -1)) });
    else if (raw.startsWith('/')) out.push({ name, kind: 'regex', re: toRegex(raw.slice(1, -1)) });
    else out.push({ name, kind: 'text', value: raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\t/g, '\t').replace(/\\n/g, '\n'), options: /nocase/i.test(src.slice(m.index, m.index + raw.length + 40)) ? { nocase: true } : {} });
  }
  const optRe = /\$([A-Za-z_]\w*)\s*=\s*"([^"]*)"\s+([a-z ]+)/g;
  while ((m = optRe.exec(src))) {
    const s = out.find((x) => x.name === m[1]);
    if (s && s.kind === 'text') s.options = { nocase: /nocase/.test(m[3]), wide: /wide/.test(m[3]), ascii: /ascii/.test(m[3]) || !/wide/.test(m[3]) };
  }
  return out;
}

function toRegex(spec) {
  let pattern = spec;
  let flags = '';
  const m = /^(.*?)([a-z]*)$/.exec(spec);
  if (m && m[2] && m[2].length <= 3 && /[isxm]/.test(m[2])) {
    pattern = m[1];
    flags = m[2].includes('i') ? 'gi' : 'g';
  }
  pattern = pattern.replace(/\\./g, (x) => (['\\d', '\\w', '\\s', '\\.', '\\*', '\\+', '\\(', '\\)', '\\[', '\\]', '\\{', '\\}', '\\|', '\\?', '\\/', '\\\\', '\\-', '\\^', '\\$', '\\:', '\\b'].includes(x) ? x : x === '\\/' ? '/' : x));
  try {
    return new RegExp(pattern, flags || 'g');
  } catch {
    return null;
  }
}

/** "{ 4D 5A ?? (61|62) [1-4] }" → sekvens av matcher. */
export function compileHex(src) {
  const tokens = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const seq = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '??') seq.push({ type: 'any' });
    else if (t.startsWith('(')) {
      const parts = [];
      while (i < tokens.length && !tokens[i].endsWith(')')) {
        parts.push(tokens[i].replace(/[()|]/g, '').replace(/^$/, ''));
        i += 1;
      }
      if (tokens[i]) parts.push(tokens[i].replace(/[()|]/g, ''));
      seq.push({ type: 'alt', values: parts.filter(Boolean).map((p) => parseInt(p, 16)) });
    } else if (/^\[\d*(-\d+)?\]$/.test(t)) {
      const m = /\[(\d+)(?:-(\d+))?\]/.exec(t);
      seq.push({ type: 'jump', min: Number(m[1]), max: m[2] ? Number(m[2]) : Number(m[1]) });
    } else if (/^[0-9a-fA-F]{2}$/.test(t)) seq.push({ type: 'byte', value: parseInt(t, 16) });
    else if (/^[0-9a-fA-F]{2}\*/.test(t)) {
      const [a, b] = t.split('*').map((x) => parseInt(x, 16));
      seq.push({ type: 'range', from: a, to: b });
    }
  }
  return seq;
}

export function matchHex(buf, seq, start = 0) {
  let p = start;
  for (const s of seq) {
    if (s.type === 'byte') {
      if (buf[p] !== s.value) return -1;
      p += 1;
    } else if (s.type === 'any') p += 1;
    else if (s.type === 'range') {
      if (buf[p] < s.from || buf[p] > s.to) return -1;
      p += 1;
    } else if (s.type === 'alt') {
      if (!s.values.includes(buf[p])) return -1;
      p += 1;
    } else if (s.type === 'jump') {
      let found = false;
      for (let k = s.min; k <= s.max + 1; k += 1) {
        if (p + k > buf.length) break;
        const rest = seq.slice(seq.indexOf(s) + 1);
        if (!rest.length || matchHex(buf, rest, p + k) >= 0) {
          p += k;
          found = true;
          break;
        }
      }
      if (!found) return -1;
    }
    if (p > buf.length) return -1;
  }
  return start;
}

function findMatches(buf, s) {
  const hits = [];
  if (s.kind === 'hex') {
    for (let i = 0; i < buf.length && hits.length < 64; i += 1) {
      if (matchHex(buf, s.pattern, i) === i) hits.push(i);
    }
    return hits;
  }
  const hay = s.kind === 'text' ? (s.options?.nocase ? buf.toString('latin1').toLowerCase() : buf.toString('latin1')) : '';
  if (s.kind === 'text') {
    const needle = s.options?.nocase ? s.value.toLowerCase() : s.value;
    let idx = -1;
    while ((idx = hay.indexOf(needle, idx + 1)) >= 0 && hits.length < 64) hits.push(idx);
    if (s.options?.wide) {
      const wide = Buffer.from(s.value.split('').join('\0') + '\0', 'latin1');
      const hayW = s.options?.nocase ? buf.toString('latin1').replaceAll('\0', '').toLowerCase() : '';
      void wide;
      void hayW;
      let i = 0;
      while (i < buf.length - s.value.length * 2 && hits.length < 128) {
        let ok = true;
        for (let k = 0; k < s.value.length; k += 1) {
          const b = buf[i + k * 2];
          const c = s.value.charCodeAt(k);
          const cc = s.options?.nocase && b >= 65 && b <= 90 ? b + 32 : b;
          if (buf[i + k * 2 + 1] !== 0 || cc !== c) {
            ok = false;
            break;
          }
        }
        if (ok) hits.push(i);
        i += 1;
      }
    }
    return hits;
  }
  if (!s.re) return hits;
  s.re.lastIndex = 0;
  const txt = buf.toString('latin1');
  let m;
  while ((m = s.re.exec(txt)) && hits.length < 64) {
    hits.push(m.index);
    if (m.index === s.re.lastIndex) s.re.lastIndex += 1;
  }
  return hits;
}

/* ------------------------------- condition --------------------------------- */

export function parseCondition(src, strings) {
  const names = strings.map((s) => s.name);
  let pos = 0;
  const text = src.trim();
  const skip = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
  };
  const peek = (n = 1) => text.slice(pos, pos + n);
  const eat = (tok) => {
    skip();
    if (text.startsWith(tok, pos)) {
      pos += tok.length;
      return true;
    }
    return false;
  };
  const fail = () => ({ type: 'const', value: false });

  function primary() {
    skip();
    if (eat('(')) {
      const e = orExpr();
      eat(')');
      return e;
    }
    if (eat('not')) return { type: 'not', expr: primary() };
    const fs = /filesize\s*(<=|>=|<|>|==)\s*(\d+)\s*(KB|MB|GB)?/i.exec(text.slice(pos));
    if (fs && fs.index === 0) {
      pos += fs[0].length;
      const mult = { KB: 1024, MB: 1024 * 1024, GB: 1024 ** 3 }[fs[3] || ''] || 1;
      return { type: 'filesize', op: fs[1], value: Number(fs[2]) * mult };
    }
    // uint8(0), uint16(0x3c), uint32be(0), int16le(...) == 0x5A4D  …
    const intAt = /\b(u?int(?:8|16|32)(?:le|be)?)\s*\(\s*(0x[0-9a-f]+|\d+)\s*\)\s*(<=|>=|==|!=|<|>)\s*(0x[0-9a-f]+|\d+)/i.exec(text.slice(pos));
    if (intAt && intAt.index === 0) {
      pos += intAt[0].length;
      const toNum = (v) => (String(v).toLowerCase().startsWith('0x') ? parseInt(v, 16) : Number(v));
      return { type: 'intAt', fn: intAt[1].toLowerCase(), offset: toNum(intAt[2]), op: intAt[3], value: toNum(intAt[4]) };
    }
    if (/^\bentrypoint\b/i.test(text.slice(pos))) {
      pos += 'entrypoint'.length;
      return { type: 'entrypoint' };
    }
    const nOf = /\b(any|all)\s+of\s+them\b/i.exec(text.slice(pos));
    if (nOf && nOf.index === 0) {
      pos += nOf[0].length;
      return { type: 'of', mode: nOf[1].toLowerCase(), list: names };
    }
    const nOf2 = /\b(\d+)\s+of\s+them\b/i.exec(text.slice(pos));
    if (nOf2 && nOf2.index === 0) {
      pos += nOf2[0].length;
      return { type: 'of', mode: 'n', n: Number(nOf2[1]), list: names };
    }
    const fam = /\b(?:any|all|(\d+))\s+of\s+\(\s*(\$\w+)\*\s*\)/i.exec(text.slice(pos));
    if (fam && fam.index === 0) {
      pos += fam[0].length;
      const list = names.filter((n) => n.startsWith(fam[2].slice(1)));
      return { type: 'of', mode: fam[1] ? 'n' : fam[2] && list.length ? 'any' : 'any', n: fam[1] ? Number(fam[1]) : 0, list };
    }
    const str = /\$(\w+)/.exec(text.slice(pos));
    if (str && str.index === 0) {
      pos += str[0].length;
      const at = /\bat\s+(0x[0-9a-f]+|\d+)/i.exec(text.slice(pos));
      if (at && at.index === 0) {
        pos += at[0].length;
        return { type: 'strAt', name: str[1], offset: Number(at[1]) };
      }
      const inRange = /\bin\s+\(\s*(0x[0-9a-f]+|\d+)\s*(?:\.\.|,)\s*(0x[0-9a-f]+|\d+|\$filesize)\s*\)/i.exec(text.slice(pos));
      if (inRange && inRange.index === 0) {
        pos += inRange[0].length;
        return { type: 'strIn', name: str[1], from: Number(inRange[1]), to: inRange[2].toLowerCase() === '$filesize' ? Infinity : Number(inRange[2]) };
      }
      return { type: 'str', name: str[1] };
    }
    const num = /^\d+/.exec(text.slice(pos));
    if (num) {
      pos += num[0].length;
      return { type: 'const', value: Number(num[0]) > 0 };
    }
    return fail();
  }

  function andExpr() {
    let left = primary();
    for (;;) {
      skip();
      if (eat('and')) left = { type: 'and', left, right: primary() };
      else break;
    }
    return left;
  }

  function orExpr() {
    let left = andExpr();
    for (;;) {
      skip();
      if (eat('or')) left = { type: 'or', left, right: andExpr() };
      else break;
    }
    return left;
  }

  try {
    return orExpr();
  } catch {
    return fail();
  }
}

function evalAst(node, ctx) {
  switch (node.type) {
    case 'const':
      return Boolean(node.value);
    case 'not':
      return !evalAst(node.expr, ctx);
    case 'and':
      return evalAst(node.left, ctx) && evalAst(node.right, ctx);
    case 'or':
      return evalAst(node.left, ctx) || evalAst(node.right, ctx);
    case 'filesize': {
      const v = ctx.size;
      return { '<': v < node.value, '>': v > node.value, '<=': v <= node.value, '>=': v >= node.value, '==': v === node.value }[node.op];
    }
    case 'intAt': {
      const b = ctx.buf;
      if (!b || node.offset < 0 || node.offset >= b.length) return false;
      const unsigned = node.fn.startsWith('uint');
      const be = node.fn.endsWith('be');
      const width = node.fn.includes('32') ? 4 : node.fn.includes('16') ? 2 : 1;
      if (node.offset + width > b.length) return false;
      let v;
      if (width === 1) v = b.readUInt8(node.offset);
      else if (width === 2) v = be ? b.readUInt16BE(node.offset) : b.readUInt16LE(node.offset);
      else v = be ? b.readUInt32BE(node.offset) : b.readUInt32LE(node.offset);
      if (!unsigned) v = width === 1 ? b.readInt8(node.offset) : width === 2 ? b.readInt16BE(node.offset) : b.readInt32BE(node.offset) & 0xffffffff | 0;
      const cmp = { '<': v < node.value, '>': v > node.value, '<=': v <= node.value, '>=': v >= node.value, '==': v === node.value, '!=': v !== node.value }[node.op];
      return Boolean(cmp);
    }
    case 'entrypoint':
      return ctx.entrypoint != null && (ctx.matches.__ep__ || []).includes(ctx.entrypoint);
    case 'str':
      return (ctx.matches[node.name]?.length || 0) > 0;
    case 'strAt':
      return (ctx.matches[node.name] || []).includes(node.offset);
    case 'strIn':
      return (ctx.matches[node.name] || []).some((o) => o >= node.from && o <= node.to);
    case 'of': {
      const count = node.list.filter((n) => ctx.matches[n]?.length).length;
      if (node.mode === 'all') return count === node.list.length && node.list.length > 0;
      if (node.mode === 'n') return count >= node.n;
      return count > 0;
    }
    default:
      return false;
  }
}

export function scan(buf, rules, { entrypoint = null } = {}) {
  const ctx0_entrypoint = entrypoint;
  const out = [];
  for (const rule of rules) {
    const matches = {};
    for (const s of rule.strings) matches[s.name] = findMatches(buf, s);
    const ctx = { size: buf.length, matches, buf, entrypoint: ctx0_entrypoint ?? null };
    let hit = false;
    try {
      hit = evalAst(rule.ast, ctx);
    } catch {
      hit = false;
    }
    if (hit) {
      out.push({
        rule: rule.name,
        tags: rule.tags,
        meta: rule.meta,
        strings: Object.entries(matches)
          .filter(([, v]) => v.length)
          .map(([name, offsets]) => ({ name, count: offsets.length, offsets: offsets.slice(0, 8) })),
      });
    }
  }
  return out;
}

function hexOf(buf) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf;
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function rulesToText(rules) {
  return rules
    .map((r) => `rule ${r.name} ${r.tags.length ? `: ${r.tags.join(' ')}` : ''} {\n  strings:\n${r.strings.map((s) => `    $${s.name} = ${s.kind === 'text' ? JSON.stringify(s.value) : s.kind === 'regex' ? String(s.re) : '{…}'}`).join('\n')}\n  condition:\n    ${r.condition}\n}`)
    .join('\n\n');
}
