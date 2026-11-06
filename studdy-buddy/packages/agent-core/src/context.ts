import type { NetAcadPageContext, TopologyObservation, ObservedQuestion, WindowInfo } from '@studdy/shared';
import { truncate } from '@studdy/shared';
import { ancestorTitles } from '@studdy/curriculum';
import type { CurriculumGraph } from '@studdy/shared';
import { conceptById } from '@studdy/learning-engine';

/**
 * Context assembly: turns raw observations into the short list of FACTS that
 * get sent to the model. Two rules:
 *
 *  1. Every fact must be labelled with where it came from, so the model can
 *     avoid over-claiming and the UI can show its evidence.
 *  2. The block has a hard size cap. Sending "everything we know" is how token
 *     bills and hallucinations both grow.
 */

export interface ContextInput {
  windows?: WindowInfo[];
  page?: NetAcadPageContext | null;
  graph?: CurriculumGraph | null;
  selection?: string | null;
  question?: ObservedQuestion | null;
  topology?: TopologyObservation | null;
  cursorDescription?: string | null;
  /** Mastery lines already formatted by the caller. */
  knowledge?: string[];
}

export interface AssembledContext {
  facts: string[];
  knowledge: string[];
  /** Concepts the current context most likely exercises. */
  conceptHints: string[];
  assessmentMode: string;
  /** Facts we refused to include, and why - shown in diagnostics. */
  excluded: string[];
}

const MAX_FACTS = 14;
const MAX_FACT_BYTES = 300;

export function assembleContext(input: ContextInput): AssembledContext {
  const facts: string[] = [];
  const excluded: string[] = [];
  const conceptHints = new Set<string>();

  if (input.page) {
    const page = input.page;
    facts.push(`NetAcad-sida: ${truncate(page.url, 120)}`);
    if (page.courseName) facts.push(`Kurs: ${page.courseName}`);
    if (page.headingPath.length) facts.push(`Sidans rubrikkedja: ${page.headingPath.join(' > ')}`);
    if (page.platformCompletedVisible !== null) {
      facts.push(`Plattformen visar avklarad-status: ${page.platformCompletedVisible ? 'ja' : 'nej'}`);
    } else {
      facts.push('Plattformen visar ingen avklarad-status på sidan.');
    }

    // Enrich with the discovered hierarchy so the model knows the module too.
    if (input.graph && page.currentNodeId) {
      const trail = ancestorTitles(input.graph, page.currentNodeId);
      if (trail.length) facts.push(`Kursstruktur: ${trail.join(' > ')}`);
      const node = input.graph.nodes.find((n) => n.id === page.currentNodeId);
      if (node) facts.push(`Aktuell nod: ${node.kind} – ${node.title}`);
    }
  }

  if (input.selection && input.selection.trim()) {
    const cleaned = input.selection.trim();
    facts.push(`Markerad text: "${truncate(cleaned, MAX_FACT_BYTES)}"`);
  }

  if (input.question) {
    const q = input.question;
    facts.push(`Synlig övningsfråga (${q.questionType}): "${truncate(q.questionText, MAX_FACT_BYTES)}"`);
    if (q.options.length) {
      facts.push(`Svarsalternativ: ${q.options.map((o) => `${o.label}) ${truncate(o.text, 80)}`).join(' | ')}`);
    }
    if (q.officialCorrectness !== null) {
      facts.push(`Plattformen visar att svaret är ${q.officialCorrectness ? 'rätt' : 'fel'}.`);
    } else {
      facts.push('Ingen officiell rätt/fel-markering syns för frågan.');
    }
    if (q.selected.length) facts.push(`Studentens val: ${q.selected.join(', ')}`);
  }

  if (input.topology) {
    const t = input.topology;
    if (t.devices.length) {
      const deviceLines = t.devices.slice(0, 5).map((d) => {
        const ifaces = d.interfaces.slice(0, 4).map((i) => `${i.name}:${i.ipAddress ?? 'ingen IP'}/${i.status}`).join(', ');
        return `${d.label} (${d.kind}, källa ${d.evidence})${ifaces ? ` – ${ifaces}` : ''}`;
      });
      facts.push(`Packet Tracer-topologi: ${deviceLines.join(' ; ')}`);
    } else {
      facts.push('Packet Tracer-fönster synligt men ingen topologi kunde läsas.');
    }
    if (t.cliOutputs.length) {
      const cli = t.cliOutputs.slice(0, 2).map((c) => `"${c.command}" visar: ${truncate(c.raw.replace(/\s+/g, ' '), 260)}`);
      facts.push(`CLI-utskrift: ${cli.join(' || ')}`);
    }
    for (const limit of t.limitations) facts.push(`Begränsning i observationen: ${limit}`);
  }

  if (input.cursorDescription) {
    facts.push(`Markören pekar på: ${truncate(input.cursorDescription, 160)}`);
  }

  const otherWindows = (input.windows ?? []).filter((w) => w.appKind === 'OTHER');
  if (otherWindows.length) {
    excluded.push(`${otherWindows.length} andra fönster (icke-godkända) uteslöts ur kontexten.`);
  }

  const assessmentMode = input.question?.mode ?? 'SELF_STUDY';

  // Concept hints: cheap keyword mapping so the learning engine can target the
  // right nodes without an extra model call.
  const searchable = [
    input.selection ?? '',
    input.page?.headingPath.join(' ') ?? '',
    input.question?.questionText ?? '',
    input.topology?.devices.map((d) => `${d.label} ${d.kind}`).join(' ') ?? '',
  ]
    .join(' ')
    .toLowerCase();

  for (const { keyword, conceptId } of CONCEPT_KEYWORDS) {
    if (searchable.includes(keyword)) conceptHints.add(conceptId);
  }

  return {
    facts: facts.slice(0, MAX_FACTS),
    knowledge: (input.knowledge ?? []).slice(0, 8),
    conceptHints: [...conceptHints],
    assessmentMode,
    excluded,
  };
}

/**
 * Keyword -> concept map used for context hints. Kept deliberately small and
 * explicit: fuzzy embedding matching would be harder to audit.
 */
export const CONCEPT_KEYWORDS: { keyword: string; conceptId: string }[] = [
  { keyword: 'arp', conceptId: 'arp' },
  { keyword: 'mac address', conceptId: 'mac-addressing' },
  { keyword: 'mac-adress', conceptId: 'mac-addressing' },
  { keyword: 'ethernet', conceptId: 'ethernet' },
  { keyword: 'switch', conceptId: 'switching' },
  { keyword: 'vlan', conceptId: 'vlan' },
  { keyword: 'subnet', conceptId: 'subnetting' },
  { keyword: 'subnät', conceptId: 'subnetting' },
  { keyword: 'cidr', conceptId: 'cidr' },
  { keyword: 'routing', conceptId: 'routing' },
  { keyword: 'static route', conceptId: 'static-routes' },
  { keyword: 'ospf', conceptId: 'routing' },
  { keyword: 'dhcp', conceptId: 'dhcp' },
  { keyword: 'dns', conceptId: 'dns' },
  { keyword: 'icmp', conceptId: 'icmp' },
  { keyword: 'ping', conceptId: 'icmp' },
  { keyword: 'osi', conceptId: 'osi-model' },
  { keyword: 'tcp/ip', conceptId: 'tcp-ip-model' },
  { keyword: 'binary', conceptId: 'binary' },
  { keyword: 'binär', conceptId: 'binary' },
  { keyword: 'encapsulation', conceptId: 'encapsulation' },
  { keyword: 'inkapsling', conceptId: 'encapsulation' },
  { keyword: 'ipv4', conceptId: 'ipv4-addressing' },
  { keyword: 'show ip', conceptId: 'cli-config' },
  { keyword: 'running-config', conceptId: 'cli-config' },
];

export function formatKnowledgeLines(estimates: { conceptId: string; probability: number; state: string; independentCorrect: number }[]): string[] {
  return estimates
    .filter((e) => e.state !== 'NOT_SEEN')
    .slice(0, 8)
    .map((e) => {
      const label = conceptById(e.conceptId)?.label ?? e.conceptId;
      const strength = e.probability >= 0.8 ? 'stark' : e.probability >= 0.55 ? 'på väg' : 'svag';
      return `${label}: ${strength} (${e.state}, ${e.independentCorrect} oberoende rätt)`;
    });
}

/** Deterministic key for an observation, used to dedupe repeated events. */
export function observationFingerprint(parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? '').trim().toLowerCase()).join('|');
}
