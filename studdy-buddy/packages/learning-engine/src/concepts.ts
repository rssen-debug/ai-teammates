/**
 * Prerequisite graph for the Cisco CCNA/DVA120 networking curriculum.
 *
 * This is an *authoring* artefact (our own concept map), not a claim about the
 * official DVA120 syllabus. The exam coach maps discovered NetAcad modules onto
 * these concepts, and the UI always shows the mapping so the student can see
 * where a claim comes from.
 */

import type { ConceptDependency } from '@studdy/shared';

export interface ConceptDef {
  id: string;
  label: string;
  domain: 'foundations' | 'layer2' | 'layer3' | 'services' | 'troubleshooting';
  /** Plain-language description used in prompts and the progress view. */
  summary: string;
}

export const CONCEPTS: ConceptDef[] = [
  { id: 'osi-model', label: 'OSI-modellen', domain: 'foundations', summary: 'De sju lagren och vad varje lager ansvarar för.' },
  { id: 'tcp-ip-model', label: 'TCP/IP-modellen', domain: 'foundations', summary: 'Hur TCP/IP-lagren motsvarar OSI.' },
  { id: 'binary', label: 'Binära tal', domain: 'foundations', summary: 'Att räkna och omvandla mellan binärt och decimalt.' },
  { id: 'ethernet', label: 'Ethernet', domain: 'layer2', summary: 'Ramformat, fält och hur Ethernet skickar data på länken.' },
  { id: 'mac-addressing', label: 'MAC-adresser', domain: 'layer2', summary: '48-bitars adresser, unicast/broadcast och lokal betydelse.' },
  { id: 'switching', label: 'Switchning', domain: 'layer2', summary: 'MAC-adresstabell, inlärning, flooding och forwarding.' },
  { id: 'arp', label: 'ARP', domain: 'layer2', summary: 'Att hitta MAC-adressen som hör till en känd IP-adress.' },
  { id: 'vlan', label: 'VLAN', domain: 'layer2', summary: 'Logisk segmentering, access/trunk-portar och 802.1Q.' },
  { id: 'ipv4-addressing', label: 'IPv4-adressering', domain: 'layer3', summary: 'Adressstruktur, klasser, privat/public och loopback.' },
  { id: 'subnet-mask', label: 'Subnet mask', domain: 'layer3', summary: 'Vad masken gör: nätverksdel kontra hostdel.' },
  { id: 'subnetting', label: 'Subnetting', domain: 'layer3', summary: 'Dela upp nät i subnät och räkna ut adresser.' },
  { id: 'cidr', label: 'CIDR', domain: 'layer3', summary: 'Prefixnotation och sammanfattning av nät.' },
  { id: 'routing', label: 'Routing', domain: 'layer3', summary: 'Routingtabell, longest match och next hop.' },
  { id: 'static-routes', label: 'Statiska rutter', domain: 'layer3', summary: 'Manuellt konfigurerade rutter och default gateway.' },
  { id: 'icmp', label: 'ICMP', domain: 'troubleshooting', summary: 'Echo request/reply och felmeddelanden.' },
  { id: 'dhcp', label: 'DHCP', domain: 'services', summary: 'DORA-processen och automatisk adresstilldelning.' },
  { id: 'dns', label: 'DNS', domain: 'services', summary: 'Namn till IP och varför ping kan fungera utan DNS.' },
  { id: 'encapsulation', label: 'Inkapsling', domain: 'foundations', summary: 'Hur data paketeras lager för lager och avkapslas igen.' },
  { id: 'cli-config', label: 'Cisco CLI', domain: 'troubleshooting', summary: 'Konfigurationslägen, show-kommandon och sparning.' },
  { id: 'troubleshooting', label: 'Felsökning', domain: 'troubleshooting', summary: 'Systematisk metod: verifiera lager för lager.' },
];

export const CONCEPT_IDS = CONCEPTS.map((c) => c.id);

/** Explicit prerequisite pairs. Transitive closure is computed on demand. */
export const DEPENDENCIES: ConceptDependency[] = [
  { conceptId: 'tcp-ip-model', prerequisiteId: 'osi-model' },
  { conceptId: 'mac-addressing', prerequisiteId: 'ethernet' },
  { conceptId: 'switching', prerequisiteId: 'mac-addressing' },
  { conceptId: 'arp', prerequisiteId: 'mac-addressing' },
  { conceptId: 'arp', prerequisiteId: 'ipv4-addressing' },
  { conceptId: 'vlan', prerequisiteId: 'switching' },
  { conceptId: 'ipv4-addressing', prerequisiteId: 'binary' },
  { conceptId: 'subnet-mask', prerequisiteId: 'ipv4-addressing' },
  { conceptId: 'subnetting', prerequisiteId: 'subnet-mask' },
  { conceptId: 'subnetting', prerequisiteId: 'binary' },
  { conceptId: 'cidr', prerequisiteId: 'subnet-mask' },
  { conceptId: 'routing', prerequisiteId: 'subnetting' },
  { conceptId: 'static-routes', prerequisiteId: 'routing' },
  { conceptId: 'icmp', prerequisiteId: 'ipv4-addressing' },
  { conceptId: 'dhcp', prerequisiteId: 'ipv4-addressing' },
  { conceptId: 'dns', prerequisiteId: 'ipv4-addressing' },
  { conceptId: 'encapsulation', prerequisiteId: 'osi-model' },
  { conceptId: 'troubleshooting', prerequisiteId: 'icmp' },
];

export function conceptById(id: string): ConceptDef | undefined {
  return CONCEPTS.find((c) => c.id === id);
}

export function prerequisiteClosure(conceptId: string): string[] {
  const seen = new Set<string>();
  const stack = [conceptId];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const dep of DEPENDENCIES) {
      if (dep.conceptId === current && !seen.has(dep.prerequisiteId)) {
        seen.add(dep.prerequisiteId);
        stack.push(dep.prerequisiteId);
      }
    }
  }
  return [...seen];
}

/**
 * Finds the deepest weak prerequisite that plausibly explains a struggle.
 * Returns ids ordered from most fundamental to most immediate.
 */
export function weakPrerequisites(
  conceptId: string,
  probabilityByConcept: Record<string, number>,
  threshold = 0.6,
): string[] {
  const closure = prerequisiteClosure(conceptId);
  const weak = closure.filter((id) => (probabilityByConcept[id] ?? 0) < threshold);
  // Sort by graph depth: fewer remaining prerequisites first.
  return weak.sort((a, b) => prerequisiteClosure(a).length - prerequisiteClosure(b).length);
}
