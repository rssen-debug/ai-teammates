/**
 * MAJIN — job submission, pure core. The browser-facing halves live in
 * tools/jobs.js (prepare/send); everything DECIDING lives here, testably:
 *   classifyField()  — what role does this form field play (generic, no
 *                      site recipes — DECISIONS, open question closed this slice)
 *   extractContact() — email/phone/links out of the CV text (regex, honest)
 *   buildProof()     — is THIS a real confirmation, or just a page that moved?
 *   planValue()      — which profile value belongs in which role
 * Nothing here shows site-specific knowledge; words are INPUT vocabulary
 * (svlex), matching is whole-word or whole-phrase, diacritics folded.
 */
import { svlex } from './model.js';

const fold = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ø/g, 'o').replace(/æ/g, 'ae')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const NAME_WORDS = svlex('name', ['name', 'namn', 'fornamn', 'förnamn', 'efternamn', 'full name', 'ditt namn', 'your name']);
const EMAIL_WORDS = svlex('email', ['email', 'e-mail', 'e-post', 'epost', 'mail', 'mailadress', 'mejl', 'e-mail address']);
const PHONE_WORDS = svlex('phone', ['phone', 'telefon', 'mobil', 'tel', 'telephone', 'mobile', 'telefonnummer']);
const CITY_WORDS = svlex('city', ['city', 'stad', 'ort', 'kommun', 'location', 'postort']);
const LINKEDIN_WORDS = svlex('linkedin', ['linkedin', 'linked in']);
const GITHUB_WORDS = svlex('github', ['github', 'portfolio', 'github profile']);
const WEBSITE_WORDS = svlex('website', ['website', 'webbsida', 'homepage', 'hemsida', 'web page', 'url', 'webbplats']);
const CV_WORDS = svlex('cv', ['cv', 'resume', 'merit', 'meritförteckning', 'meritforteckning', 'upload your cv', 'attach cv', 'bilaga', 'attachment']);
const COVER_WORDS = svlex('coverletter', ['cover letter', 'personal letter', 'personligt brev', 'motivering', 'covering letter', 'ansökningsbrev', 'ansokningsbrev', 'brief', 'letter']);
const MESSAGE_WORDS = svlex('message', ['message', 'meddelande', 'comment', 'kommentar', 'additional information', 'övrigt', 'ovrigt', 'tell us about yourself', 'berätta om dig själv', 'beratta om dig sjalv']);

const IGNORE_TYPES = new Set(['hidden', 'password', 'submit', 'button', 'reset', 'image']);

/** Which roles can a tag type even hold? (a file input is never a phone) */
const TYPE_GATE = {
  file: new Set(['cv']),
  select: new Set(['city', 'other']),
  textarea: new Set(['coverletter', 'message', 'other']),
  email: new Set(['email', 'name', 'other']),
  tel: new Set(['phone', 'name', 'other']),
  url: new Set(['linkedin', 'github', 'website', 'other']),
};

function hitsAny(text, words) {
  const padded = ` ${text} `;
  let best = 0;
  for (const w of words) {
    if (!w) continue;
    if (padded.includes(` ${w} `) || (w.includes(' ') && padded.includes(w))) best = Math.max(best, w.length);
  }
  return best;
}

/** classifyField({tag,type,name,id,label,aria,placeholder}) → {role, why}
    Longest whole-word match decides; ties keep the first role by declaration
    order here (specificity order: contact specifics before generic buckets). */
export function classifyField(f) {
  const tag = String(f.tag || '').toLowerCase();
  const type = String(f.type || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')).toLowerCase();
  if (tag === 'input' && IGNORE_TYPES.has(type)) return { role: 'ignore', why: `type ${type} is not a fillable answer` };
  const text = fold([f.label, f.aria, f.placeholder, f.name, f.id].filter(Boolean).join(' '));
  if (!text && type !== 'file') return { role: 'other', why: 'no words tell us what this field wants' };

  const roleWords = [
    ['email', EMAIL_WORDS[1]],
    ['phone', PHONE_WORDS[1]],
    ['linkedin', LINKEDIN_WORDS[1]],
    ['github', GITHUB_WORDS[1]],
    ['website', WEBSITE_WORDS[1]],
    ['name', NAME_WORDS[1]],
    ['city', CITY_WORDS[1]],
    ['cv', CV_WORDS[1]],
    ['coverletter', COVER_WORDS[1]],
    ['message', MESSAGE_WORDS[1]],
  ];
  let role = 'other', best = 0, why = 'no keyword claimed it';
  for (const [r, words] of roleWords) {
    const gate = TYPE_GATE[type];
    if (gate && !gate.has(r) && r !== 'other') continue;
    const score = hitsAny(text, words.map(fold));
    if (score > best) { best = score; role = r; }
  }
  if (best) why = `matched ${best} chars of ${role} vocabulary`;
  if (role === 'other' && type === 'file') { role = 'cv'; why = 'a bare file input in an application form wants the CV'; }
  if (role === 'email' && type !== 'email' && TYPE_GATE.email && !TYPE_GATE.email.has(role)) role = 'other';
  return { role, why };
}

/* ------------------------- contact from the CV --------------------------- */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(\+?46|0)[\s-]?\d{2,3}[\s-]?\d{2,3}[\s-]?\d{2,3}[\s-]?\d{0,2}\b/;
const LINK_RE = /(https?:\/\/)?(www\.)?(linkedin\.com\/[^\s)"']+|github\.com\/[^\s)"']+)/gi;

export function extractContact(cvText) {
  const text = String(cvText || '');
  const email = (EMAIL_RE.exec(text) || [null])[0];
  const phoneRaw = (PHONE_RE.exec(text) || [null])[0];
  const links = [...text.matchAll(LINK_RE)].map((m) => String(m[0]).replace(/^(https?:\/\/)?(www\.)?/, ''));
  return {
    email: email || null,
    phone: phoneRaw ? phoneRaw.replace(/\s+/g, ' ').trim() : null,
    linkedin: links.find((l) => l.includes('linkedin.com')) || null,
    github: links.find((l) => l.includes('github.com')) || null,
  };
}

/* ------------------------------ values ----------------------------------- */

/** planValue(role, {profile, coverLetter}) → value|null — null = we say so,
    we never invent a phone number. */
export function planValue(role, { profile = {}, coverLetter = '' } = {}) {
  switch (role) {
    case 'name': return profile.name || null;
    case 'email': return profile.email || null;
    case 'phone': return profile.phone || null;
    case 'city': return profile.city || null;
    case 'linkedin': return profile.linkedin || null;
    case 'github': return profile.github || profile.portfolio || null;
    case 'website': return profile.website || null;
    case 'coverletter': return coverLetter || profile.coverLetter || null;
    case 'cv': return '__cv__'; // sentinel: the file input, not text
    default: return null;
  }
}

/* --------------------------- type coercion ------------------------------- */

/** A value must survive the page's own constraint validation, or the submit
    click silently does NOTHING and the user thinks the form said no.
    Found 2026-10-18: github.com/x into <input type=url> → invalid → no POST. */
export function coerceForType(value, type) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (String(type).toLowerCase() === 'url' && !/^https?:\/\//i.test(v)) return 'https://' + v;
  return v;
}

/* ------------------------------ the proof -------------------------------- */

const CONFIRM_WORDS = svlex('confirm', ['thank you for your application', 'your application has been submitted', 'application received', 'we have received your application', 'tack för din ansökan', 'tack for din ansokan', 'ansökan har skickats', 'ansokan har skickats', 'din ansökan är skickad', 'din ansokan ar skickad', 'vi återkommer', 'vi aterkommer', 'we will get back to you', 'we will be in touch', 'application has been sent', 'ansökan mottagen', 'ansokan mottagen', 'bekräftelse på din ansökan']); // svlex( marker must share the line — the gate reads line-wise

/** buildProof({urlBefore, urlAfter, pageText, shotPath}) →
    {accepted, kind:'words'|'url+words'|'none', url, words[]}
    Words in the page beat gut feeling; a url change alone is not proof:
    many portals redirect to a fresh form. (Pinned by test.) */
export function buildProof({ urlBefore = '', urlAfter = '', pageText = '', shotPath = null } = {}) {
  const folded = fold(pageText);
  const words = CONFIRM_WORDS[1].map(fold).filter((w) => folded.includes(w));
  const moved = urlAfter && urlBefore && fold(urlAfter) !== fold(urlBefore);
  if (words.length) {
    return { accepted: true, kind: moved ? 'url+words' : 'words', url: urlAfter || urlBefore, words, shot: shotPath || null };
  }
  return { accepted: false, kind: 'none', url: urlAfter || urlBefore, words: [], shot: shotPath || null, why: 'no confirmation words on the page after the click' };
}

/* ---------------------- page-side snippets (strings) --------------------- */

/** Walk the DOM for fillable fields; page-side function body. Returns
    [{tag,type,name,id,label,aria,placeholder,required}] — capped, visible only. */
export const SCAN_SNIPPET = `(() => {
  const out = [];
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return el.labels[0].innerText.trim();
    const wrap = el.closest('label'); if (wrap) return wrap.innerText.trim().slice(0, 120);
    if (el.getAttribute('aria-labelledby')) { const t = document.getElementById(el.getAttribute('aria-labelledby')); if (t) return t.innerText.trim().slice(0, 120); }
    return '';
  };
  let i = 0;
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (out.length >= 60) break;
    if (el.disabled || el.readOnly && el.type !== 'file') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2 && el.type !== 'hidden' && el.type !== 'file') continue;
    const id = 'majin-f' + (i++);
    el.setAttribute('data-majin', id);
    out.push({ sel: '[data-majin="' + id + '"]', tag: el.tagName.toLowerCase(), type: (el.type || el.tagName.toLowerCase()), name: el.name || '', id: el.id || '', label: labelOf(el).slice(0, 120), aria: (el.getAttribute('aria-label') || '').slice(0, 120), placeholder: (el.getAttribute('placeholder') || '').slice(0, 120), required: !!el.required });
  }
  return out;
})()`;

/** Click the likeliest submit control. Returns {clicked, text} — never a guess:
    it reports exactly which control we touched (or none). */
/* the submit-control vocabulary, input data again (svlex) — the page-side
   snippet receives it as a JSON literal below */
export const SUBMIT_WORDS = svlex('submit-words', ['skicka ansökan', 'skicka ansokan', 'skicka in', 'submit application', 'send application', 'apply now', 'ansök nu', 'ansok nu', 'skicka', 'submit', 'apply', 'send']);

export const SUBMIT_SNIPPET = `(() => {
  const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
  const words = ${JSON.stringify(SUBMIT_WORDS[1])}.map(fold);
  const cands = [...document.querySelectorAll('button, input[type=submit], [role=button], a.btn, a.button')];
  const text = (el) => fold((el instanceof HTMLInputElement ? el.value : el.innerText) || '');
  let best = null, bestLen = 0;
  for (const el of cands) {
    const t = text(el);
    for (let wi = 0; wi < words.length; wi++) {
      if (t.includes(words[wi])) {
        const score = words[wi].length * 100 - wi; // longer phrase wins; earlier word breaks ties
        if (score > bestLen) { best = el; bestLen = score; }
      }
    }
  }
  if (!best) return { clicked: false, why: 'no control looked like a submit button', candidates: cands.length, texts: cands.slice(0, 8).map((el) => text(el).slice(0, 40)) };
  best.scrollIntoView({ block: 'center' });
  const label = text(best).slice(0, 80);
  best.click();
  return { clicked: true, text: label };
})()`;

/** Page main text, capped — the proof reader. */
export const TEXT_SNIPPET = `(() => {
  const el = document.querySelector('main') || document.body;
  return { url: location.href, title: document.title, text: String(el.innerText || '').slice(0, 60000) };
})()`;
