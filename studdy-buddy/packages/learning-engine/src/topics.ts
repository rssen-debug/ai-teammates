/**
 * Generic topic/concept extraction.
 *
 * The original concept map in `concepts.ts` is a hand-authored CCNA/DVA120
 * graph. That is fine as *seed knowledge*, but the product must work for a
 * student reading biology on Canvas, or law, or Python. So the learning engine
 * also accepts **dynamic concepts** derived from what the student actually
 * studies:
 *
 *   curriculum node title  +  heading trail  +  selected text
 *        -> keyphrases -> stable concept ids -> same BKT mastery model
 *
 * Design rules:
 *  - deterministic: the same text always yields the same ids, so progress
 *    survives restarts and two runs cannot produce different topics.
 *  - language-agnostic: no English-only word lists. Swedish compound nouns are
 *    handled by keeping long tokens intact.
 *  - no AI call: this runs on every page load, so it must be cheap and offline.
 *  - honest: a keyphrase is a *topic the page is about*, not a claim that the
 *    student knows it. Only evidence moves mastery.
 */

import type { ConceptDependency } from '@studdy/shared';

export interface ExtractedConcept {
  /** Stable id: `dyn:<slug>`. */
  id: string;
  /** Display label, in the language of the source text. */
  label: string;
  /** Always 'dynamic' - the UI can show where a topic came from. */
  domain: string;
  /** How often it appeared in the source text. Used for ordering only. */
  weight: number;
}

/** Words that carry no topical meaning. Short, bilingual (sv/en). */
const STOPWORDS = new Set([
  // Swedish
  'och', 'att', 'det', 'som', 'för', 'med', 'den', 'till', 'inte', 'har', 'kan', 'ska', 'vid',
  'från', 'eller', 'men', 'när', 'hur', 'vad', 'vilka', 'vilken', 'detta', 'denna', 'dessa',
  'exempel', 'sida', 'kapitel', 'modul', 'avsnitt', 'övning', 'uppgift', 'fråga', 'svar',
  'inledning', 'sammanfattning', 'översikt', 'syfte', 'mål', 'del', 'kommer', 'efter', 'innan',
  'också', 'redan', 'bara', 'sedan', 'mellan', 'under', 'över', 'genom', 'samt', 'varje',
  // English
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your', 'you', 'not',
  'are', 'was', 'were', 'has', 'been', 'they', 'their', 'there', 'these', 'those', 'which',
  'what', 'when', 'how', 'why', 'can', 'could', 'should', 'would', 'about', 'into', 'than',
  'then', 'them', 'also', 'some', 'such', 'only', 'more', 'most', 'other', 'each', 'over',
  'chapter', 'module', 'section', 'lesson', 'unit', 'page', 'example', 'exercise', 'question',
  'answer', 'introduction', 'summary', 'overview', 'objectives', 'part', 'video', 'quiz',
]);

/** Suffixes stripped when normalising Swedish/English plurals and definiteness. */
const SUFFIXES = ['erna', 'arna', 'orna', 'ande', 'ende', 'ing', 'ning', 'het', 'tion', 'erna', 'er', 'en', 'ar', 'or', 'et', 'es', 's'];

const MIN_TOKEN = 3;
/** Very long tokens are usually Swedish compounds; keep them, they are topical. */
const MAX_TOKEN = 40;

export function slugifyToken(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, MAX_TOKEN);
}

/** Crude, deterministic stemmer. Good enough for grouping, not linguistics. */
export function stem(token: string): string {
  let t = token.toLowerCase();
  if (t.length <= 5) return t;
  for (const suffix of SUFFIXES) {
    if (t.length - suffix.length >= 4 && t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length);
      break;
    }
  }
  return t;
}

export function tokenize(text: string): string[] {
  return text
    .split(/[^0-9A-Za-zÅÄÖåäöÉéÜü-]+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length >= MIN_TOKEN && t.length <= MAX_TOKEN)
    .filter((t) => !STOPWORDS.has(t.toLowerCase()))
    .filter((t) => !/^\d+$/.test(t));
}

function conceptIdFor(stemmed: string): string {
  return `dyn:${slugifyToken(stemmed)}`;
}

/**
 * Extracts topics from a blob of study material.
 *
 * `weight` is a recency/repetition count, not a score of importance. Callers
 * order by weight so the most-mentioned topics are the ones that get tracked
 * first, which keeps the concept table from exploding on a long course page.
 */
export function extractConcepts(text: string, max = 12): ExtractedConcept[] {
  const counts = new Map<string, { label: string; count: number }>();

  for (const token of tokenize(text)) {
    const key = stem(token);
    if (key.length < MIN_TOKEN) continue;
    const id = conceptIdFor(key);
    const existing = counts.get(id);
    if (existing) existing.count += 1;
    else counts.set(id, { label: token, count: 1 });
  }

  return [...counts.entries()]
    .map(([id, v]) => ({ id, label: v.label, domain: 'dynamic', weight: v.count }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
    .slice(0, max);
}

/**
 * Extracts topics from a curriculum graph plus the current page, which is what
 * the app actually has: node titles are far better signal than a raw paragraph.
 */
export function extractConceptsFromStudyContext(input: {
  courseName?: string | null;
  nodeTitles?: string[];
  headingPath?: string[];
  selection?: string | null;
  max?: number;
}): ExtractedConcept[] {
  const parts: string[] = [];
  // Titles and headings are repeated so their tokens outrank incidental prose.
  for (const title of input.nodeTitles ?? []) parts.push(title, title);
  for (const heading of input.headingPath ?? []) parts.push(heading, heading);
  if (input.selection) parts.push(input.selection.slice(0, 2000));
  // Course name is deliberately *not* used: it appears on every page and would
  // become the most "important" topic in the whole course.
  void input.courseName;
  return extractConcepts(parts.join(' '), input.max ?? 12);
}

/**
 * A dynamic topic depends on nothing explicitly; the curriculum ordering
 * (module 1 -> module 2) is expressed by `deriveCurriculumDependencies`.
 */
export function deriveCurriculumDependencies(input: {
  /** Ordered node ids with their titles, in the order the course presents them. */
  orderedNodes: { id: string; title: string }[];
  maxLinks?: number;
}): ConceptDependency[] {
  const maxLinks = input.maxLinks ?? 40;
  const conceptsPerNode = input.orderedNodes.map((n) => ({
    id: n.id,
    concepts: extractConcepts(n.title, 3).map((c) => c.id),
  }));
  const deps: ConceptDependency[] = [];
  for (let i = 1; i < conceptsPerNode.length; i += 1) {
    const prev = conceptsPerNode[i - 1];
    const curr = conceptsPerNode[i];
    if (!prev || !curr) continue;
    for (const conceptId of curr.concepts) {
      // The immediately preceding node is the assumed prerequisite. It is a
      // heuristic and the UI labels it as "kursordning", never as a fact.
      const prerequisiteId = prev.concepts[0];
      if (!prerequisiteId || prerequisiteId === conceptId) continue;
      deps.push({ conceptId, prerequisiteId });
      if (deps.length >= maxLinks) return deps;
    }
  }
  return deps;
}
