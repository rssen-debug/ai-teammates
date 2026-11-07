/**
 * MAJIN — MOA (Mixture of Agents), always on.
 * N referenser svarar parallellt → mejselft {agreement} → aggregator skriver
 * slutgiltigt svar. Låg enighet = eskalera till tyngre modell. Det är hela algoritmen.
 */
import { bus } from './log.js';
import { complete } from './provider/chat.js';

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[`*_#>]/g, '')
    .replace(/[.,;:!?"'()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shingles(s, n = 3) {
  const w = normalize(s).split(' ').filter(Boolean);
  if (w.length < n) return new Set(w.length ? [w.join(' ')] : []);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i += 1) out.add(w.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const NUM = /-?\d+(?:[.,]\d+)?/g;

export function numbers(s) {
  return new Set((String(s).match(NUM) || []).map((x) => x.replace(',', '.')));
}

/**
 * agreement = 0.6 * mean pairwise token-shingle jaccard + 0.4 * numeric overlap
 * Numerik väger eftersom det är där modeller ljuger mest.
 */
export function agreement(texts) {
  const clean = (texts || []).filter(Boolean);
  if (!clean.length) return { score: 0, detail: { pairs: 0 } };
  if (clean.length < 2) return { score: 1, detail: { pairs: 0 } };
  const sets = clean.map((t) => shingles(t));
  let sum = 0;
  let pairs = 0;
  let min = 1;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const v = jaccard(sets[i], sets[j]);
      sum += v;
      pairs += 1;
      min = Math.min(min, v);
    }
  }
  const textSim = sum / pairs;
  const nums = clean.map(numbers);
  let numOk = 1;
  if (nums.some((n) => n.size)) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < nums.length; i += 1) {
      for (let j = i + 1; j < nums.length; j += 1) {
        const inter = [...nums[i]].filter((x) => nums[j].has(x)).length;
        const uni = new Set([...nums[i], ...nums[j]]).size;
        a += inter;
        b += uni;
      }
    }
    numOk = b ? a / b : 1;
  }
  return { score: Number((0.6 * textSim + 0.4 * numOk).toFixed(3)), textSim: Number(textSim.toFixed(3)), numbers: Number(numOk.toFixed(3)), min: Number(min.toFixed(3)), pairs };
}

export function parseAnswers(text) {
  const out = [];
  const re = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:ANSWER|SVAR)\s*\[?(\d+)\]?\s*(?:\[[^\]]*\])?\s*[:：]\s*/gi;
  let m;
  const marks = [];
  while ((m = re.exec(text))) marks.push({ n: Number(m[1]), start: m.index + m[0].length, at: m.index });
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    out.push({ n: marks[i].n, text: text.slice(marks[i].start, end).trim() });
  }
  return out.length ? out : null;
}

const REF_SYSTEM = (style) =>
  `You are one of ${style.width} parallel reference models in a Mixture-of-Agents group. Answer the user question directly with your best answer. Nothing about being a model, no apologies, no metadata. At most ${style.maxChars} characters. ${style.style}`;

const AGG_SYSTEM = `You are the aggregator model in a Mixture-of-Agents group. You get the question and ${'N'} parallel answers.
Rules:
1. Keep only claims supported by at least one answer.
2. On conflict: pick the most concrete, verifiable answer and say briefly who is unsure.
3. Merge the best into one answer in the language of the question.
4. No "according to model 1" references in the body — a footnote is enough if needed.
5. Shorter than the references. Keep algorithms and code verbatim.`;

/**
 * @returns {Promise<{answer:string, refs:Array, agreement:Object, escalated:boolean, usage:Object}>}
 */
export async function run({ cfg, question, context, job, onEvent, signal, maxTokens, forceWidth, extraSystem, usage: store = null }) {
  const moa = cfg.moaConfig();
  const width = Math.max(1, Math.min(forceWidth ?? moa.width ?? 3, moa.references.length));
  const refs = moa.references.slice(0, width);
  const usage = { input: 0, output: 0, costUsd: 0 };
  const t0 = Date.now();
  if (!moa.enabled || width < 2) {
    const route = cfg.resolveModel(cfg.get(`models.routes.${job}`) || cfg.get('models.routes.final'), job);
    const res = await complete({ route, job, stream: true, maxTokens, messages: [...(extraSystem ? [{ role: 'system', content: extraSystem }] : []), ...(context || []), { role: 'user', content: question }], onEvent, signal });
    return { answer: res.text, refs: [], agreement: { score: 1, single: true }, escalated: false, usage: addUsage(usage, res.usage, route), elapsedMs: Date.now() - t0 };
  }

  onEvent?.({ type: 'moa:start', width, refs: refs.map((r) => r.model), job });
  const results = await Promise.all(
    refs.map(async (r, i) => {
      const route = cfg.resolveModel(r.model, job);
      const prompt = [
        ...(extraSystem ? [{ role: 'system', content: extraSystem }] : []),
        ...(context || []),
        { role: 'user', content: question },
      ];
      try {
        const res = await complete({
          route,
          job: `${job}:moa`,
          stream: false,
          maxTokens: r.maxTokens ?? moa.referenceMaxTokens ?? 900,
          temperature: r.temperature ?? 0.5,
          messages: prompt,
          signal,
          mockKey: `moa-ref-${i}`,
        });
        onEvent?.({ type: 'moa:ref', i, model: r.model, chars: (res.text || '').length, ms: res.elapsedMs });
        return { i, ref: r.model, text: (res.text || '').trim(), usage: addUsage(empty(), res.usage, route), error: null };
      } catch (err) {
        bus.warn('moa.ref.failed', { i, model: r.model, error: err.message });
        return { i, ref: r.model, text: '', usage: empty(), error: err.message };
      }
    }),
  );
  for (const r of results) usage.input += r.usage.input, (usage.output += r.usage.output), (usage.costUsd += r.usage.costUsd || 0);

  const ok = results.filter((r) => r.text);
  const agr = agreement(ok.map((r) => r.text));
  let escalated = false;

  if (ok.length < 2) {
    const answer = ok[0]?.text || 'MOA: every reference failed, answering without them.';
    onEvent?.({ type: 'moa:degraded', reason: ok.length ? 'one reference survived' : 'no references' });
    return { answer, refs: results, agreement: { ...agr, score: 0 }, escalated, usage, elapsedMs: Date.now() - t0 };
  }

  const floor = moa.disagreementFloor ?? 0.25;
  const escalateOnLow = cfg.get('routing.escalateOnDisagreement') !== false;
  if (escalateOnLow && agr.score < floor) {
    escalated = true;
    const strong = cfg.resolveModel(cfg.get('models.routes.analysis') || cfg.get(`models.routes.${job}`), `${job}:escalate`);
    const res = await complete({
      route: strong,
      job: `${job}:escalate`,
      stream: false,
      maxTokens: moa.referenceMaxTokens ?? 900,
      temperature: 0,
      messages: [{ role: 'system', content: 'Answer briefly and exactly. You are the tie-breaker in a MOA group that could not agree.' }, ...(context || []), { role: 'user', content: question }],
      signal,
    });
    if (res.text) {
      ok.push({ i: ok.length, ref: `${strong.ref} (tie-breaker)`, text: res.text.trim(), usage: addUsage(empty(), res.usage, strong), error: null });
      usage.input += res.usage?.input || 0;
      usage.output += res.usage?.output || 0;
      usage.costUsd += res.usage?.costUsd || 0;
      onEvent?.({ type: 'moa:escalate', from: agr.score, to: agreement(ok.map((r) => r.text)).score, model: strong.ref });
    }
  }
  const finalAgr = agreement(ok.map((r) => r.text));

  for (const r of ok) store?.record({ job: `moa:${job}`, ref: r.ref, usage: r.usage, moa: true });

  const aggRoute = cfg.resolveModel(moa.aggregator || cfg.get('models.routes.aggregator'), `${job}:aggregator`);
  const numbered = ok.map((r, i) => `ANSWER ${i + 1} [${r.ref}]:\n${clip(r.text, 2600)}`).join('\n\n');
  let answer = '';
  try {
    const res = await complete({
      route: aggRoute,
      job: `${job}:aggregator`,
      stream: true,
      maxTokens: maxTokens ?? moa.aggregatorMaxTokens ?? 4096,
      temperature: 0.15,
      messages: [
        { role: 'system', content: AGG_SYSTEM.replace('N', String(ok.length)) },
        {
          role: 'user',
          content: `QUESTION:\n${clip(question, 6000)}\n\nANSWERS FROM ${ok.length} REFERENCES (agreement ${finalAgr.score}):\n\n${numbered}`,
        },
      ],
      onEvent,
      signal,
    });
    answer = res.text;
    store?.record({ job: `moa:${job}`, ref: aggRoute?.ref || 'aggregator', usage: res.usage, moa: true });
    usage.input += res.usage?.input || 0;
    usage.output += res.usage?.output || 0;
    usage.costUsd += res.usage?.costUsd || 0;
  } catch (err) {
    bus.warn('moa.aggregator.failed', { error: err.message });
    answer = bestOf(ok);
    onEvent?.({ type: 'moa:degraded', reason: `aggregator felade: ${err.message}` });
  }

  onEvent?.({ type: 'moa:done', score: finalAgr.score, refs: ok.length, escalated, ms: Date.now() - t0, agreement: finalAgr });
  return { answer: answer.trim() || bestOf(ok), refs: results, agreement: finalAgr, escalated, usage, elapsedMs: Date.now() - t0 };
}

function bestOf(ok) {
  const sorted = [...ok].sort((a, b) => b.text.length - a.text.length);
  return sorted[0]?.text || '';
}

const empty = () => ({ input: 0, output: 0, costUsd: 0 });

function addUsage(u, usage, route) {
  const out = { ...u };
  out.input += usage?.input || 0;
  out.output += usage?.output || 0;
  const { costOf } = { costOf: (r, u) => ((u?.input || 0) / 1e6) * (r?.pricing?.in || 0) + ((u?.output || 0) / 1e6) * (r?.pricing?.out || 0) };
  out.costUsd += costOf(route, usage);
  return out;
}

export function clip(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n)}\n…[${str.length - n} chars clipped]`;
}
