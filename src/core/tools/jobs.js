/**
 * MAJIN — jobs. The job-search agent as tools (the skills layer composes;
 * these are the primitives):
 *   jobs.search  → find candidates (Platsbanken), dedupe against the pipeline
 *   jobs.match   → score found jobs against the CV, promote winners to matched
 *   jobs.cv.set/show → the CV in plain text
 *   jobs.list    → the pipeline, grouped by status
 *   jobs.start / jobs.skip → the user's own moves on an application
 * Submission (form-fill + proof) is the NEXT slice and will be approval-gated
 * by design — this slice inlines a refusal instead of half-a-submit.
 */
import { def } from './registry.js';
import { resolveIn } from './files.js';
import fs from 'node:fs';
import { searchPlatsbanken } from '../jobs/platsbanken.js';
import { createApplication, transition, scoreCv, cvSkills } from '../jobs/model.js';
import { loadCv, saveCv, loadApplications, saveApplications, upsertApplication, cvPath, jobsDir } from '../jobs/store.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { openFor, isOpen } from '../browser.js';
import { classifyField, planValue, extractContact, buildProof, coerceForType, SCAN_SNIPPET, SUBMIT_SNIPPET, TEXT_SNIPPET } from '../jobs/formfill.js';

/* ---- submit-slice helpers (mirror browser.fill/browser.upload's CDP flow,
   deliberately local: the job tools must not reach into another group's
   tool definitions to borrow half a body). ---- */
async function fillOne(b, sel, value) {
  const selJson = JSON.stringify(String(sel));
  const valJson = JSON.stringify(String(value ?? ''));
  return b.eval('(() => { try {' +
    'const el = document.querySelector(' + selJson + ');' +
    'if (!el) { return { found: false }; }' +
    'el.focus();' +
    "const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);" +
    "const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;" +
    'if (setter) { setter.call(el, ' + valJson + '); } else { el.value = ' + valJson + '; }' +
    "el.dispatchEvent(new Event('input', { bubbles: true }));" +
    "el.dispatchEvent(new Event('change', { bubbles: true }));" +
    'let valid = true; try { valid = el.checkValidity(); } catch (e) { valid = true; }' +
    'return { found: true, stuck: el.value === ' + valJson + ', valid: valid, value: String(el.value).slice(0, 60) };' +
  ' } catch (err) { return { found: false, error: String(err && err.message) }; } })()');
}

async function attachFile(b, sel, abs) {
  await b.send('DOM.enable');
  const { root } = await b.send('DOM.getDocument');
  const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: String(sel) });
  if (!nodeId) return { ok: false };
  await b.send('DOM.setFileInputFiles', { files: [abs], nodeId });
  const selJson = JSON.stringify(String(sel));
  return b.eval('(() => { const el = document.querySelector(' + selJson + ');' +
    ' const f = el && el.files && el.files[0]; return f ? { ok: true, name: f.name, size: f.size } : { ok: false }; })()');
}


const pick = (apps, fp) => {
  const app = apps[fp];
  if (!app) {
    const near = Object.values(apps).filter((a) => JSON.stringify(a).toLowerCase().includes(String(fp).toLowerCase()))[0];
    const err = new Error(near ? `no application ${fp} — did you mean ${near.fp} (${near.title} @ ${near.company})?` : `no application ${fp} — run jobs.list to see the pipeline`);
    err.code = 'no_such_application';
    throw err;
  }
  return app;
};

export const jobTools = [
  def({
    name: 'jobs.search',
    group: 'jobs',
    desc: 'Search job sites (Platsbanken/SE for now) for candidates. NEW jobs enter the pipeline as "found" — already-seen jobs are counted, not re-shown. Returns titles/companies/deadlines/URLs + the fp you need for the other jobs.* tools.',
    risk: 'read',
    params: {
      query: 'string: search words, e.g. "webbutvecklare stockholm" or "python"',
      limit: 'number: max results (default: 8, max 25, optional)',
      includeSeen: 'boolean: also list jobs already in the pipeline (default: false, optional)',
    },
    required: ['query'],
    run: async ({ query, limit = 8, includeSeen = false }) => {
      const r = await searchPlatsbanken({ q: query, limit: Math.min(25, Math.max(1, limit)) });
      if (!r.ok) return { ok: false, error: r.error };
      const apps = await loadApplications();
      const fresh = [];
      let seen = 0;
      for (const job of r.jobs) {
        const app = createApplication(job);
        if (apps[app.fp]) {
          seen += 1;
          if (includeSeen) fresh.push({ ...apps[app.fp], alreadySeen: true });
          continue;
        }
        apps[app.fp] = app;
        fresh.push(app);
      }
      await saveApplications(apps);
      return {
        ok: true,
        total: fresh.length,
        seenBefore: seen,
        applications: fresh.map((a) => ({ fp: a.fp, title: a.title, company: a.company, city: a.city, deadline: a.deadline, url: a.url, apply: a.apply, alreadySeen: a.alreadySeen || undefined })),
        summary: `${fresh.filter((a) => !a.alreadySeen).length} new jobs found (${seen} seen before, hidden${includeSeen ? ' — includeSeen was on' : ''})`,
      };
    },
  }),

  def({
    name: 'jobs.match',
    group: 'jobs',
    desc: 'Score every pipeline application with status "found" against the saved CV; those at/above minScore move to "matched" with the match report attached as evidence. Needs a CV (jobs.cv.set first).',
    risk: 'read',
    params: {
      minScore: 'number: 0..1 where at/above counts as matched (default: 0.4, optional)',
    },
    run: async ({ minScore = 0.4 }) => {
      const cv = await loadCv();
      if (!cv) return { ok: false, error: { code: 'no_cv', message: 'there is no CV saved yet', hint: 'save one first: jobs.cv.set with your CV text or {file: "cv.txt"}' } };
      const apps = await loadApplications();
      const fresh = Object.values(apps).filter((a) => a.status === 'found');
      if (!fresh.length) return { ok: true, matched: [], below: 0, summary: 'nothing new to score — run jobs.search first' };
      const matched = [];
      let below = 0;
      for (const app of fresh) {
        const report = scoreCv(cv.text, { title: app.title, description: app.description || '', mustHave: app.mustHave, niceToHave: app.niceToHave });
        app.score = report.score;
        if (report.score != null && report.score >= minScore) {
          transition(app, 'matched', { by: 'cv-match', evidence: report });
          matched.push({ fp: app.fp, title: app.title, company: app.company, score: report.score, matched: report.matched, missing: report.missing, apply: app.apply });
          await upsertApplication(app);
        } else {
          below += 1;
          await upsertApplication(app);
        }
      }
      return { ok: true, matched, below, minScore, summary: matched.length ? `${matched.length} job(s) matched your CV (checked ${fresh.length}, minScore ${minScore})` : `no job reached ${minScore} (checked ${fresh.length})` };
    },
  }),

  def({
    name: 'jobs.list',
    group: 'jobs',
    desc: 'Show the application pipeline grouped by status (found/matched/started/waiting/submitted/failed/skipped) with counts — your proof that each submission happened lives in each entry\'s history.',
    risk: 'read',
    params: { status: 'string: only this status [found|matched|started|waiting|submitted|failed|skipped] (optional)' },
    run: async ({ status = '' }) => {
      const apps = await loadApplications();
      const all = Object.values(apps).sort((a, b) => b.updatedAt - a.updatedAt);
      const counts = {};
      for (const a of all) counts[a.status] = (counts[a.status] || 0) + 1;
      const rows = all
        .filter((a) => !status || a.status === status)
        .slice(0, 40)
        .map((a) => `${a.fp} [${a.status}${a.score != null ? ` ${a.score}` : ''}] ${a.title} · ${a.company}${a.city ? ` · ${a.city}` : ''}${a.deadline ? ` · deadline ${String(a.deadline).slice(0, 10)}` : ''}`)
        .join('\n');
      return { ok: true, counts, applications: rows || '(empty)', summary: Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no applications yet — run jobs.search' };
    },
  }),

  def({
    name: 'jobs.start',
    group: 'jobs',
    desc: 'Mark an application as started (you — or a follow-up task — are working on it). fp comes from jobs.search / jobs.list.',
    risk: 'write',
    params: {
      fp: 'string: the application fingerprint from jobs.search or jobs.list',
      note: 'string: what is happening, e.g. "cover letter drafted" (optional)',
    },
    required: ['fp'],
    run: async ({ fp, note = '' }) => {
      const apps = await loadApplications();
      const app = pick(apps, fp);
      transition(app, 'started', { by: 'user', evidence: note ? { note } : null });
      await upsertApplication(app);
      return { ok: true, fp: app.fp, status: app.status };
    },
  }),

  def({
    name: 'jobs.skip',
    group: 'jobs',
    desc: 'Mark an application as skipped (you decided not to pursue it). Skipped jobs never reappear in searches.',
    risk: 'write',
    params: {
      fp: 'string: the application fingerprint from jobs.search or jobs.list',
      why: 'string: one honest line why, for your own memory (optional)',
    },
    required: ['fp'],
    run: async ({ fp, why = '' }) => {
      const apps = await loadApplications();
      const app = pick(apps, fp);
      transition(app, 'skipped', { by: 'user', evidence: why ? { note: why } : null });
      await upsertApplication(app);
      return { ok: true, fp: app.fp, status: app.status };
    },
  }),

  def({
    name: 'jobs.cv.set',
    group: 'jobs',
    desc: 'Save your CV (plain text) so jobs.match can score jobs against it. Give the text directly or a workspace file ({file: "cv.txt"}). Stored inside MAJIN_HOME — never uploaded anywhere.',
    risk: 'write',
    params: {
      text: 'string: the CV as plain text (optional)',
      file: 'string: workspace file containing the CV (optional)',
    },
    run: async ({ text = '', file = '' }, ctx) => {
      let body = String(text || '');
      if (!body && file) {
        body = fs.readFileSync(resolveIn(ctx, file), 'utf8');
      }
      if (!body.trim()) return { ok: false, error: { code: 'empty_cv', message: 'the CV is empty', hint: 'pass {text: "..."} or {file: "cv.txt"}' } };
      const meta = await saveCv(body);
      return { ok: true, chars: meta.chars, skills: cvSkills(body), summary: `CV saved (${meta.chars} chars, ${cvSkills(body).length} skills recognized)` };
    },
  }),

  def({
    name: 'jobs.cv.show',
    group: 'jobs',
    desc: 'Show the saved CV summary: length, recognized skills, when it was saved. (The full text is yours — ask and it answers with the whole thing.)',
    risk: 'read',
    params: { full: 'boolean: return the entire CV text (default: false, optional)' },
    run: async ({ full = false }) => {
      const cv = await loadCv();
      if (!cv) return { ok: false, error: { code: 'no_cv', message: 'there is no CV saved yet', hint: 'jobs.cv.set with your CV text or {file: "cv.txt"}' } };
      return {
        ok: true,
        chars: cv.text.length,
        updatedAt: cv.updatedAt,
        skills: cvSkills(cv.text),
        text: full ? cv.text.slice(0, 12000) : undefined,
        summary: `CV: ${cv.text.length} chars, ${cvSkills(cv.text).length} skills recognized`,
      };
    },
  }),
  def({
    name: 'jobs.prepare',
    group: 'jobs',
    risk: 'exec',
    desc: 'Open a job application form in your task\u2019s own browser, fill every field we can honestly map (contact details from the CV + any answers you pass, the CV file itself), and move the application to "waiting". Returns the EXACT preview of what jobs.send would send — review it, then send.',
    params: {
      fp: 'string: the application fingerprint from jobs.search or jobs.list',
      name: 'string: your name — the CV is never name-guessed (optional)',
      email: 'string: override the CV email (optional)',
      phone: 'string: override the CV phone (optional)',
      city: 'string: your city (optional)',
      linkedin: 'string: your LinkedIn url (optional)',
      github: 'string: your github/portfolio url (optional)',
      website: 'string: your website (optional)',
      coverLetter: 'string: cover letter text for the message field (optional)',
      headless: 'boolean: run the browser headless (default: true, optional)',
    },
    required: ['fp'],
    run: async ({ fp, headless = true, coverLetter = '', ...answers }, ctx) => {
      const apps = await loadApplications();
      const app = pick(apps, fp);
      if (['submitted', 'skipped'].includes(app.status)) {
        return { ok: false, error: { code: 'done_is_done', message: 'this application is ' + app.status + ' — done is done', hint: 'jobs.list shows the whole pipeline' } };
      }
      if (!app.apply || !app.apply.url) {
        return { ok: false, error: { code: 'no_apply_url', message: app.apply && app.apply.email ? 'this job applies by EMAIL (' + app.apply.email + ') — the email path is a different handshake and is honestly not built yet' : 'this job has no application url captured', hint: 'email applications: next slice; jobs.list shows what we know' } };
      }
      const cv = await loadCv();
      const session = ctx.session || 'default';
      const b = await openFor({ session, url: app.apply.url, headless: headless !== false, cfgGet: (k) => ctx.cfg.get(k) });
      const fields = await b.eval(SCAN_SNIPPET);
      const profile = { ...(cv ? extractContact(cv.text) : {}), ...Object.fromEntries(Object.entries(answers).filter(([, v]) => v)) };
      const preview = [];
      const gaps = [];
      for (const f of fields) {
        const { role, why } = classifyField(f);
        if (role === 'ignore') continue;
        if (role === 'cv') {
          if (!cv) { gaps.push({ role, label: f.label || f.name, why: 'no CV saved for the file input' }); continue; }
          const up = await attachFile(b, f.sel, cvPath());
          preview.push({ role, label: f.label || f.name || '(file input)', filled: Boolean(up && up.ok), value: up && up.ok ? 'file: ' + up.name : null, note: why });
          continue;
        }
        let value = planValue(role, { profile, coverLetter });
        if (value == null) { gaps.push({ role, label: f.label || f.name, why }); continue; }
        value = coerceForType(value, f.type);
        const r = await fillOne(b, f.sel, value);
        preview.push({ role, label: f.label || f.name || f.sel, filled: Boolean(r && r.stuck), value: r && r.stuck ? String(value).slice(0, 60) : null, valid: r && r.stuck ? r.valid !== false : undefined, note: r && !r.stuck ? 'the page rejected the value' : r && r.valid === false ? 'FILLED BUT INVALID — this blocks the submit' : why });
      }
      if (app.status !== 'waiting') {
        if (app.status !== 'started') transition(app, 'started', { by: 'agent', evidence: { note: 'preparing the application form' } });
        transition(app, 'waiting', { by: 'agent', evidence: { preview } });
      }
      await upsertApplication(app);
      return {
        ok: true,
        fp: app.fp,
        status: 'waiting',
        preview,
        gaps,
        summary: 'form prepared: ' + preview.filter((x) => x.filled).length + '/' + preview.length + ' fields filled' + (gaps.length ? ', ' + gaps.length + ' need you' : '') + ' — review the preview, then jobs.send ' + fp,
      };
    },
  }),

  def({
    name: 'jobs.send',
    group: 'jobs',
    risk: 'destructive',
    desc: 'SUBMIT a prepared application (status "waiting"). This is the real thing: it clicks the form\u2019s submit control and then DEMANDS proof — confirmation words on the result page, saved screenshot, url. No proof = no "submitted": the status stays waiting for YOU to check, because an unsent application marked sent is the worst lie this product can tell.',
    params: { fp: 'string: the application fingerprint (must be "waiting" — run jobs.prepare first)' },
    required: ['fp'],
    run: async ({ fp }, ctx) => {
      const apps = await loadApplications();
      const app = pick(apps, fp);
      if (app.status !== 'waiting') {
        return { ok: false, error: { code: 'not_prepared', message: 'this application is "' + app.status + '", not waiting — jobs.prepare fills the form first, you review, then send', hint: app.status === 'submitted' ? 'it is already submitted — done is done' : 'run jobs.prepare ' + fp } };
      }
      const session = ctx.session || 'default';
      if (!isOpen(session)) return { ok: false, error: { code: 'browser_closed', message: 'the prepare browser was closed — jobs.prepare again to rebuild the exact form state' } };
      const b = await openFor({ session, cfgGet: (k) => ctx.cfg.get(k) });
      const before = await b.eval(TEXT_SNIPPET).catch(() => ({ url: '' }));
      /* the page is the referee: an invalid field CANCELS submission silently
         ("github.com/x" into type=url learned us that). Ask it first. */
      const validity = await b.eval("(() => { const f = document.querySelector('form'); if (!f) return { valid: true, note: 'no form on page' }; const bad = [...f.querySelectorAll(':invalid')].map((x) => (x.labels && x.labels[0] ? x.labels[0].innerText.trim().slice(0, 40) : null) || x.name || x.id || x.type); return { valid: f.checkValidity(), invalid: bad }; })()").catch(() => ({ valid: true }));
      if (validity && validity.valid === false) {
        return { ok: false, error: { code: 'invalid_form', message: 'the page refuses these values as-is: ' + JSON.stringify(validity.invalid || []) + ' — the submit would be silently cancelled by the browser', hint: 'fix the fields (jobs.prepare with better answers), then jobs.send again' } };
      }
      let click = await b.eval(SUBMIT_SNIPPET);
      if (!click || !click.clicked) {
        await new Promise((r) => setTimeout(r, 1500));
        const again = await b.eval(SUBMIT_SNIPPET).catch(() => null);
        if (again && again.clicked) click = again;
      }
      if (!click || !click.clicked) {
        transition(app, 'failed', { by: 'agent', evidence: { error: 'no submit control found on the form', candidates: click && click.candidates, texts: click && click.texts } });
        await upsertApplication(app);
        return { ok: false, error: { code: 'no_submit', message: 'no control on the page looked like a submit button (' + (click ? click.candidates + ' candidates: ' + JSON.stringify(click.texts || []) : 'eval failed') + ')', hint: 'the form may need you in a windowed browser — jobs.prepare with headless:false and finish by hand' } };
      }
      await new Promise((r) => setTimeout(r, 2300));
      try { await b.followNewTarget({ windowMs: 1200 }); } catch { /* single-page flow is fine */ }
      const proofDir = path.join(jobsDir(), 'proofs');
      await fsp.mkdir(proofDir, { recursive: true });
      let shotPath = null;
      try {
        const shot = await b.send('Page.captureScreenshot', { format: 'png' });
        shotPath = path.join(proofDir, app.fp + '-' + Date.now() + '.png');
        await fsp.writeFile(shotPath, Buffer.from(shot.data, 'base64'));
      } catch { /* words can still prove it */ }
      /* real portals answer at their own pace — read the page up to 3 s apart;
         the proof bar never moves (confirmation WORDS or nothing) */
      let page = { url: before.url, text: '' };
      let proof = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        page = await b.eval(TEXT_SNIPPET).catch(() => ({ url: page.url || before.url, text: page.text || '' }));
        proof = buildProof({ urlBefore: before.url, urlAfter: page.url, pageText: page.text || '', shotPath });
        if (proof.accepted) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!proof.accepted) {
        const seen = String(page.text || '').replace(/\s+/g, ' ').slice(0, 200);
        return { ok: false, error: { code: 'no_proof', message: 'clicked "' + (click.text || 'submit') + '" but no confirmation words appeared on the page — the application MAY NOT have been sent. It stays "waiting" until we see proof. Last page read: ' + (page.url || '?') + ' showing: "' + (seen || '(empty)') + '" · screenshot: ' + String(shotPath || 'none') } };
      }
      transition(app, 'submitted', { by: 'agent', evidence: { proof, clicked: click.text || null } });
      await upsertApplication(app);
      return { ok: true, fp: app.fp, status: 'submitted', proof, summary: 'application submitted — proof: ' + proof.words.join(' / ') + (proof.shot ? ' · shot saved' : '') };
    },
  }),
];
