import type { CurriculumGraph, CurriculumNode, CurriculumNodeKind } from '@studdy/shared';
import { stableKey } from '@studdy/shared';

/**
 * Curriculum discovery from the *shape of the page*, never from constants.
 *
 * The product requirement is explicit: do not hardcode 17 modules. So this
 * module takes a neutral snapshot of what the browser extension can actually
 * read and derives whatever hierarchy that snapshot supports. If a course
 * exposes 17 modules we report 17; if it exposes 9, we report 9; if part of the
 * tree is not readable we mark it inaccessible rather than inventing it.
 */

export interface RawLink {
  text: string;
  href: string | null;
  /** Nesting depth hint (indentation, aria-level or list nesting). */
  depth: number;
  /** Completion state only if the page literally tells us. */
  completed?: boolean | null;
}

export interface RawHeading {
  level: number;
  text: string;
}

export interface RawPageSnapshot {
  url: string;
  title: string;
  /** Course name from a heading/landmark, if present. */
  courseName: string | null;
  headings: RawHeading[];
  /** Navigation items (sidebar / table of contents), in document order. */
  navLinks: RawLink[];
  /** True when the page renders content in an iframe we cannot read. */
  contentInIframe: boolean;
  capturedAt: string;
}

const KIND_PATTERNS: { kind: CurriculumNodeKind; re: RegExp }[] = [
  { kind: 'QUIZ', re: /\b(quiz|test|examination|tentamen|prov)\b/i },
  { kind: 'LAB', re: /\b(lab|packet tracer|laboration)\b/i },
  { kind: 'ACTIVITY', re: /\b(activity|interactive|practice|övning|aktivitet)\b/i },
  { kind: 'MODULE', re: /\b(module|modul)\b/i },
  { kind: 'CHAPTER', re: /\b(chapter|kapitel)\b/i },
  { kind: 'OBJECTIVE', re: /\bobjective|mål\b/i },
  { kind: 'SECTION', re: /^\s*\d+(\.\d+)*\s+/ },
  { kind: 'LESSON', re: /./ },
];

/** Classifies a navigation label. Order matters: QUIZ before LESSON. */
export function classifyLabel(text: string): CurriculumNodeKind {
  for (const pattern of KIND_PATTERNS) {
    if (pattern.re.test(text)) return pattern.kind;
  }
  return 'LESSON';
}

/** Extracts a leading numeric path like "3.2.1" when present. */
export function numericPath(text: string): string | null {
  const match = /^\s*(\d+(?:\.\d+)*)\b/.exec(text);
  return match?.[1] ?? null;
}

export interface DiscoveryResult {
  graph: CurriculumGraph;
  warnings: string[];
  /** True when we could only see part of the course. */
  partial: boolean;
}

/**
 * Builds a curriculum graph from one page snapshot.
 *
 * Identity: numeric path when available (stable across sessions), otherwise a
 * hash of the parent path + title + href. Never random, so progress survives
 * restarts and two modules with identical titles in different chapters cannot
 * collide.
 */
export function discoverCurriculum(snapshot: RawPageSnapshot): DiscoveryResult {
  const warnings: string[] = [];
  const courseName = snapshot.courseName?.trim() || snapshot.title.trim() || 'Kurs';
  const courseId = `course:${stableKey(snapshot.url.split('?')[0], courseName)}`;

  const nodes: CurriculumNode[] = [];
  const byPath = new Map<string, CurriculumNode>();

  const root: CurriculumNode = {
    id: courseId,
    kind: 'COURSE',
    title: courseName,
    order: 0,
    url: snapshot.url,
    parentId: null,
    platformCompleted: null,
    inaccessible: false,
  };
  nodes.push(root);

  if (snapshot.contentInIframe) {
    warnings.push(
      'Kursinnehållet ligger i en iframe som tillägget inte får läsa. Strukturen kan därför vara ofullständig.',
    );
  }
  if (snapshot.navLinks.length === 0) {
    warnings.push('Inga navigeringselement hittades på sidan, så kursstrukturen kunde inte läsas.');
  }

  // Track the node at each depth so a shallow item closes deeper branches.
  const stack: CurriculumNode[] = [root];

  for (const link of snapshot.navLinks) {
    const title = normalizeTitle(link.text);
    if (!title) continue;
    const kind = classifyLabel(title);
    const path = numericPath(title);
    const depth = Math.max(1, Math.min(link.depth || kindToDepth(kind), 8));

    // A numeric path gives us an exact parent path, which is more reliable than depth.
    let parent: CurriculumNode = root;
    if (path) {
      const parts = path.split('.');
      const parentPath = parts.slice(0, -1).join('.');
      const candidate = parentPath ? byPath.get(parentPath) : root;
      parent = candidate ?? nearestByDepth(stack, depth - 1) ?? root;
    } else {
      parent = nearestByDepth(stack, depth - 1) ?? root;
    }

    const baseId = path
      ? `node:${stableKey(courseId, path)}`
      : `node:${stableKey(courseId, parent.id, title, link.href ?? '')}`;

    // Collapse a duplicate id onto the existing node rather than creating a twin.
    const existing = nodes.find((n) => n.id === baseId);
    if (existing) {
      existing.platformCompleted = mergeCompletion(existing.platformCompleted, link.completed ?? null);
      continue;
    }

    const node: CurriculumNode = {
      id: baseId,
      kind,
      title,
      order: orderForParent(nodes, parent.id) + 1,
      url: link.href ? absolutize(link.href, snapshot.url) : null,
      parentId: parent.id,
      platformCompleted: link.completed ?? null,
      inaccessible: false,
    };
    nodes.push(node);
    if (path) byPath.set(path, node);

    // Maintain the depth stack: drop everything at or below this depth.
    while (stack.length > depth) stack.pop();
    while (stack.length < depth) stack.push(stack[stack.length - 1] ?? root);
    stack[depth - 1] = node;
    void parent;
  }

  // Headings are reconciled against the nav tree FIRST. A page heading such as
  // "Module 3: Protocols and Models" usually describes a module that already
  // exists in the sidebar as "Module 3: Topic 3" -- adding it blindly would
  // double-count modules, which is exactly the failure the spec warns about.
  const claimedTitles = new Set<string>();
  for (const heading of snapshot.headings) {
    const title = normalizeTitle(heading.text);
    if (!title || title.toLowerCase() === courseName.toLowerCase()) continue;
    const match = matchHeadingToNode(nodes, title);
    if (match) {
      claimedTitles.add(match.title.toLowerCase());
      // The heading is a display variant of a known node, not a new one.
      match.url = match.url ?? snapshot.url;
      continue;
    }
    claimedTitles.add(title.toLowerCase());
  }

  const navTitles = new Set(nodes.map((n) => n.title.toLowerCase()));
  for (const heading of snapshot.headings) {
    const title = normalizeTitle(heading.text);
    if (!title || navTitles.has(title.toLowerCase()) || !claimedTitles.has(title.toLowerCase())) continue;
    // Only headings that no nav item represented become content nodes.
    const alreadyAdded = nodes.some((n) => n.title.toLowerCase() === title.toLowerCase());
    if (alreadyAdded) continue;
    if (title.toLowerCase() === courseName.toLowerCase()) continue;
    if (heading.level < 2) continue;
    nodes.push({
      id: `node:${stableKey(courseId, 'heading', heading.level, title)}`,
      kind: heading.level <= 2 ? 'MODULE' : heading.level === 3 ? 'SECTION' : 'LESSON',
      title,
      order: orderForParent(nodes, courseId) + 1,
      url: null,
      parentId: courseId,
      platformCompleted: null,
      inaccessible: snapshot.contentInIframe,
    });
  }

  const modules = nodes.filter((n) => n.kind === 'MODULE');
  if (modules.length === 0 && snapshot.navLinks.length > 0) {
    warnings.push('Sidan hade navigering men inga tydliga moduler. Strukturen visas som den lästes av.');
  }

  return {
    graph: {
      courseId,
      courseName,
      sourceUrl: snapshot.url,
      discoveredAt: snapshot.capturedAt,
      nodes,
    },
    warnings,
    partial: snapshot.contentInIframe,
  };
}

/**
 * Finds the deepest node whose title best matches the current page headings.
 * Used for "where is the student right now" without guessing from the URL alone.
 */
export function locateCurrentNode(graph: CurriculumGraph, snapshot: RawPageSnapshot): CurriculumNode | null {
  const headingTitles = snapshot.headings.map((h) => normalizeTitle(h.text).toLowerCase()).filter(Boolean);
  if (headingTitles.length === 0) return null;

  const candidates = graph.nodes.filter((n) => n.kind !== 'COURSE');
  let best: { node: CurriculumNode; score: number } | null = null;

  for (const node of candidates) {
    const title = node.title.toLowerCase();
    const path = numericPath(node.title);
    let score = 0;

    // Exact numeric path match against any heading is the strongest signal.
    for (const heading of headingTitles) {
      const headingPath = numericPath(heading);
      if (path && headingPath && path === headingPath) score += 6;
      if (title && heading.includes(title)) score += 3;
      if (title && heading === title) score += 2;
    }
    // Deepest matching node wins ties, so we report the lesson not its module.
    if (node.url && snapshot.url.includes(stripHost(node.url))) score += 2;
    score += depthOf(graph, node) * 0.1;

    if (!best || score > best.score) best = { node, score };
  }

  return best && best.score >= 2 ? best.node : null;
}

export function depthOf(graph: CurriculumGraph, node: CurriculumNode): number {
  let depth = 0;
  let current: CurriculumNode | undefined = node;
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    current = graph.nodes.find((n) => n.id === current?.parentId);
    depth += 1;
  }
  return depth;
}

/** Ancestor chain, outermost first. Used to build the context block for the model. */
export function ancestorTitles(graph: CurriculumGraph, nodeId: string): string[] {
  const out: string[] = [];
  let current = graph.nodes.find((n) => n.id === nodeId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.kind !== 'COURSE') out.unshift(current.title);
    current = current.parentId ? graph.nodes.find((n) => n.id === current?.parentId) : undefined;
  }
  return out;
}

export function countByKind(graph: CurriculumGraph): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of graph.nodes) out[node.kind] = (out[node.kind] ?? 0) + 1;
  return out;
}

/** Matches a page heading to an existing nav node by numeric path or leading number. */
export function matchHeadingToNode(nodes: CurriculumNode[], headingTitle: string): CurriculumNode | null {
  const headingPath = numericPath(headingTitle);
  const headingNumber = headingPath?.split('.')[0] ?? /^\D*?(\d+)\b/.exec(headingTitle)?.[1] ?? null;
  if (!headingNumber) return null;

  const candidates = nodes.filter((n) => n.kind !== 'COURSE');
  // Exact numeric path beats a bare first-segment match; shallowest wins ties so
  // "Module 3" binds to the module rather than to "3.1.2".
  const exact = candidates.filter((n) => {
    const p = numericPath(n.title);
    return p !== null && p === headingPath;
  });
  if (exact.length) return exact[0] ?? null;

  const sameModule = candidates
    .filter((n) => {
      const p = numericPath(n.title) ?? /^\D*?(\d+)\b/.exec(n.title)?.[1] ?? null;
      return p !== null && p.split('.')[0] === headingNumber;
    })
    .sort((a, b) => depthOfNodes(nodes, a) - depthOfNodes(nodes, b));
  return sameModule[0] ?? null;
}

/** Depth without a full graph object (used during construction). */
export function depthOfNodes(nodes: CurriculumNode[], node: CurriculumNode): number {
  let depth = 0;
  let current: CurriculumNode | undefined = node;
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    current = nodes.find((n) => n.id === current?.parentId);
    depth += 1;
  }
  return depth;
}

function normalizeTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function kindToDepth(kind: CurriculumNodeKind): number {
  switch (kind) {
    case 'MODULE':
      return 1;
    case 'CHAPTER':
      return 2;
    case 'SECTION':
      return 3;
    case 'LESSON':
      return 4;
    default:
      return 4;
  }
}

function nearestByDepth(stack: CurriculumNode[], depth: number): CurriculumNode | undefined {
  if (depth <= 0) return stack[0];
  for (let i = Math.min(depth, stack.length) - 1; i >= 0; i -= 1) {
    const candidate = stack[i];
    if (candidate) return candidate;
  }
  return stack[0];
}

function orderForParent(nodes: CurriculumNode[], parentId: string): number {
  let max = 0;
  for (const node of nodes) if (node.parentId === parentId) max = Math.max(max, node.order ?? 0);
  return max;
}

function mergeCompletion(a: boolean | null, b: boolean | null): boolean | null {
  if (a === null) return b;
  if (b === null) return a;
  return a && b;
}

function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function stripHost(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}
