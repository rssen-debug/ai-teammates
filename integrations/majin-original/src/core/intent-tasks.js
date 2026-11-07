/** MAJIN — deterministic natural-language control of the running task fleet.
 *
 * "Agent 2, hjälp agent 1" must NEVER cost a model call to route: the fleet
 * of live tasks is right here, in memory, addressable by ordinal in creation
 * order (the order the user MEANS — agent 1 is the first thing they asked
 * for, agent 2 the second). This parser is the full routing layer; unknowns
 * answer in plain words instead of guessing.
 *
 * Resolved by hand, no LLM:
 *   stop  — "stoppa agent 2", "kill t-x3", "avbryt den andra"
 *   pause / resume — "pausa agent 1", "resume agent 2" (pause = stop now,
 *                    the task remembers; resume = a follow-up to the SAME
 *                    session, unbroken context)
 *   status — "vad gör alla", "list agents", "visa uppgifter"
 *   assist — "agent 2, hjälp agent 1", "låt alla hjälpa jobbsökningen",
 *            "skapa en hjälpare åt agent 1"  → routes a handoff message to
 *            the helper session; the engine handles the actual work
 *
 * Ordinal rule: agent N = the N-th OLDEST ACTIVE task. Ends-of-life tasks
 * vanish from the count so ordinals always match the visible live state.
 */

const ORD_WORD = {
  första: 1, forsta: 1, first: 1,
  andra: 2, second: 2,
  tredje: 3, third: 3,
  fjärde: 4, fjarde: 4, fourth: 4,
  femte: 5, fifth: 5,
};

const norm = (s) => String(s || '').toLowerCase();

/** Find a task from a spoken reference. liveTasks = active list OLDEST first. */
export function resolveRef(ref, liveTasks) {
  const r = norm(ref).trim();
  if (!liveTasks.length) return { ok: false, error: 'no agents are running right now' };
  const wordToN = (w) => ORD_WORD[w] || (/^(\d+)$/.test(w) ? Number(w) : null);
  const direct = liveTasks.find((t) => t.id === r);
  if (direct) return { ok: true, task: direct };
  const mAgent = /(?:agent|task|uppgift)\s+([\w-]+)/.exec(r);
  const head = r.replace(/^(?:agent|task|uppgift)\s+/, '').trim();
  if (mAgent) {
    const n = wordToN(norm(mAgent[1]));
    if (n != null) {
      const t = liveTasks[n - 1];
      if (t) return { ok: true, task: t };
      return { ok: false, error: `there is no active agent ${n} right now (${liveTasks.length} active)` };
    }
    const byId = liveTasks.find((t) => t.id === mAgent[1]);
    if (byId) return { ok: true, task: byId };
  } else {
    const n = wordToN(head);
    if (n != null) {
      const t = liveTasks[n - 1];
      if (t) return { ok: true, task: t };
    }
  }
  /* name-based: "den om jobben" — stem-match so jobb also finds jobbsökningen */
  const words = r.split(/\s+/).filter((w) => w.length >= 4);
  const hits = liveTasks.filter((t) => {
    const iw = norm(t.input).split(/[\s,.:;!?\/-]+/).filter((w) => w.length >= 3);
    return words.some((w) => iw.some((tw) => tw.startsWith(w) || w.startsWith(tw)));
  });
  if (hits.length === 1) return { ok: true, task: hits[0] };
  if (hits.length > 1) return { ok: false, error: `that matches several agents: ${hits.map((h) => h.id).join(', ')} — name one of them` };
  return { ok: false, error: liveTasks.length ? 'found no such agent among the active ones' : 'no agents are running right now' };
}

/** Parse intent. Returns null (not a command — let the model have it) or
    { action, target?, helper?, message? }. liveTasks = oldest-first ACTIVE. */
export function parseTaskCommand(input, liveTasks) {
  const s = norm(input).trim();

  const assist = /(?:(?:agent|uppgift)\s+([\wåäö-]+)[,;\s]*(?:ska\s+)?)?(?:hjälpa|hjalpa|hjälp|stötta|stotta|stödja|stodja|help|assist|förstärk|forstark)\s+(?:agent|uppgift|alla|all|everyone)?\s*([\wåäö-]+)/.exec(s);
  if (assist) {
    const allMatch = assist[2] != null && /^(?:alla|all|everyone)$/.test(assist[2]);
    const helperRef = assist[1] ? `agent ${assist[1]}` : '';
    const targetRef = allMatch ? null : assist[2];
    return {
      action: 'assist',
      /* helper named? — resolve it; "låt alla hjälpa …" or a bare "hjälp …"
         means every OTHER active agent (all=true marker, expanded by caller) */
      helper: helperRef ? resolveRef(helperRef, liveTasks) : { ok: true, all: true },
      target: targetRef ? resolveRef(targetRef, liveTasks) : { ok: false, error: 'help with WHAT? name the task' },
      raw: input,
    };
  }

  if (/^(?:stoppa|stanna|stop|kill|avbryt|avsluta|cancel)\b/.test(s)) {
    const ref = s.replace(/^(?:stoppa|stanna|stop|kill|avbryt|avsluta|cancel)\s*/, '');
    return { action: 'stop', target: resolveRef(ref || 'första', liveTasks), raw: input };
  }
  if (/^(?:pausa|pause|frysa|frys)\b/.test(s)) {
    const ref = s.replace(/^(?:pausa|pause|frysa|frys)\s*/, '');
    return { action: 'pause', target: resolveRef(ref || 'första', liveTasks), raw: input };
  }
  if (/^(?:fortsätt|fortsatt|resume|continue|återuppta|ateruppta)\b/.test(s)) {
    const ref = s.replace(/^(?:fortsätt|fortsatt|resume|continue|återuppta|ateruppta)\s*/, '');
    return { action: 'resume', target: resolveRef(ref || 'första', liveTasks), raw: input };
  }

  if (/(?:vad gör|vad gor|visa|list|lista|status på|status pa|hur mår|hur mar).*(?:agent|agenter|uppgift|uppgifter|task)/.test(s) || /^(?:status|agents|tasks)$/.test(s)) {
    return { action: 'status', raw: input };
  }

  return null;
}

/** The pause→resume pair in engine terms: pause is a tracked stop that keeps
    the session alive; resume is an ordinary follow-up turn into the SAME
    session with a nudge — context never breaks between them. */
export function statusText(liveTasks) {
  if (!liveTasks.length) return 'No agents are running right now. Say what you want done and I will start one.';
  const lines = liveTasks.map((t, i) => `agent ${i + 1} (${t.id}) — ${t.status}: ${t.input.slice(0, 70)}`);
  return lines.join('\n');
}
