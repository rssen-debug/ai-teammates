/**
 * The networking question bank.
 *
 * These are ORIGINAL questions written for this project - not official Cisco or
 * DVA120 exam items, and never presented as such. Every item is deterministic
 * and self-checking, which is what lets the quiz engine grade without an LLM
 * call (cheap, fast, and impossible to hallucinate).
 */

export type Difficulty = 'BEGINNER' | 'FOUNDATION' | 'INTERMEDIATE' | 'EXAM_LEVEL' | 'ADVANCED';
export type QuestionKind =
  | 'MULTIPLE_CHOICE'
  | 'SHORT_ANSWER'
  | 'TRUE_FALSE_REASONING'
  | 'SUBNETTING'
  | 'BINARY'
  | 'CLI_INTERPRET'
  | 'NETWORK_DIAGNOSIS'
  | 'EXPLAIN_BACK';

export interface QuizOption {
  id: string;
  text: string;
  correct: boolean;
  /** Typical wrong answer: used to build a misconception explanation. */
  misconception?: string;
}

export interface Question {
  id: string;
  conceptId: string;
  kind: QuestionKind;
  difficulty: Difficulty;
  prompt: string;
  options?: QuizOption[];
  /** Accepted literal answers for SHORT_ANSWER/BINARY/SUBNETTING (normalised). */
  accepted?: string[];
  /** For CLI questions: the command output shown to the student. */
  context?: string;
  explanation: string;
  hint: string;
  /** Extra guidance shown on a wrong answer. */
  onWrong: string;
  /** Rubric lines used for open-ended (EXPLAIN_BACK) self-assessment. */
  rubric?: string[];
}

export const DIFFICULTY_ORDER: Difficulty[] = ['BEGINNER', 'FOUNDATION', 'INTERMEDIATE', 'EXAM_LEVEL', 'ADVANCED'];

export function difficultyWeight(d: Difficulty): 1 | 2 | 3 | 4 | 5 {
  switch (d) {
    case 'BEGINNER':
      return 1;
    case 'FOUNDATION':
      return 2;
    case 'INTERMEDIATE':
      return 3;
    case 'EXAM_LEVEL':
      return 4;
    case 'ADVANCED':
      return 5;
  }
}

export const QUESTIONS: Question[] = [
  // --- OSI / TCP-IP -------------------------------------------------------
  {
    id: 'osi-1',
    conceptId: 'osi-model',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'BEGINNER',
    prompt: 'Vilket OSI-lager ansvarar för att skicka enskilda bitar över en fysisk länk?',
    options: [
      { id: 'a', text: 'Lager 1 – Physical', correct: true },
      { id: 'b', text: 'Lager 2 – Data Link', correct: false, misconception: 'Lager 2 hanterar ramar och MAC-adresser, inte själva bitarna på kabeln.' },
      { id: 'c', text: 'Lager 3 – Network', correct: false, misconception: 'Lager 3 hanterar IP-adresser och routing.' },
      { id: 'd', text: 'Lager 4 – Transport', correct: false, misconception: 'Lager 4 hanterar TCP/UDP och segmentering.' },
    ],
    explanation: 'Lager 1 beskriver hur ettor och nollor färdas över mediets signalnivå.',
    hint: 'Tänk på det lager som beskriver kabeln, kontakten och signalen.',
    onWrong: 'Dela upp det: kablar och signaler = lager 1, ramar och MAC = lager 2.',
  },
  {
    id: 'osi-2',
    conceptId: 'osi-model',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'FOUNDATION',
    prompt: 'En switch bygger en MAC-adresstabell. Vilket OSI-lager arbetar den på?',
    options: [
      { id: 'a', text: 'Lager 2', correct: true },
      { id: 'b', text: 'Lager 3', correct: false, misconception: 'Lager 3-enheter (routern) använder IP-adresser. En switch använder MAC-adresser.' },
      { id: 'c', text: 'Lager 4', correct: false },
      { id: 'd', text: 'Lager 7', correct: false },
    ],
    explanation: 'MAC-adresser och Ethernet-ramar är lager 2, så switchning sker på lager 2.',
    hint: 'MAC-adressen hör till samma lager som Ethernet-ramen.',
    onWrong: 'Fråga dig vilken adresstyp som används: MAC = lager 2, IP = lager 3.',
  },
  {
    id: 'tcpip-1',
    conceptId: 'tcp-ip-model',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'FOUNDATION',
    prompt: 'Vilket TCP/IP-lager motsvarar OSI-lagren 5–7?',
    options: [
      { id: 'a', text: 'Application', correct: true },
      { id: 'b', text: 'Transport', correct: false },
      { id: 'c', text: 'Internet', correct: false },
      { id: 'd', text: 'Network Access', correct: false },
    ],
    explanation: 'TCP/IP-modellen slår ihop OSI 5, 6 och 7 till ett Application-lager.',
    hint: 'TCP/IP har färre lager än OSI. Vilka slås ihop?',
    onWrong: 'Rita de två modellerna bredvid varandra: OSI 5–7 = TCP/IP Application.',
  },

  // --- Binary -------------------------------------------------------------
  {
    id: 'bin-1',
    conceptId: 'binary',
    kind: 'BINARY',
    difficulty: 'BEGINNER',
    prompt: 'Skriv decimaltalet 13 i binär form (8 bitar).',
    accepted: ['00001101', '1101'],
    explanation: '13 = 8 + 4 + 1, alltså bitarna 8, 4 och 1 satta: 00001101.',
    hint: 'Platsvärdena är 128 64 32 16 8 4 2 1. Vilka behöver du summera för att få 13?',
    onWrong: 'Börja från vänster: 8 får plats i 13, rest 5. 4 får plats, rest 1. 1 får plats.',
  },
  {
    id: 'bin-2',
    conceptId: 'binary',
    kind: 'BINARY',
    difficulty: 'FOUNDATION',
    prompt: 'Vad är 10101000 binärt i decimalt?',
    accepted: ['168'],
    explanation: '128 + 32 + 8 = 168.',
    hint: 'Summera platsvärdena där det står en etta.',
    onWrong: 'Platsvärden: 128, 64, 32, 16, 8, 4, 2, 1. Ettor på 128, 32 och 8.',
  },

  // --- IPv4 ---------------------------------------------------------------
  {
    id: 'ipv4-1',
    conceptId: 'ipv4-addressing',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'FOUNDATION',
    prompt: 'Vilken av adresserna är en privat IPv4-adress?',
    options: [
      { id: 'a', text: '192.168.10.5', correct: true },
      { id: 'b', text: '8.8.8.8', correct: false, misconception: '8.8.8.8 är en publik adress (Googles DNS).' },
      { id: 'c', text: '172.15.0.1', correct: false, misconception: '172.15 ligger utanför det privata intervallet 172.16.0.0–172.31.255.255.' },
      { id: 'd', text: '11.0.0.1', correct: false },
    ],
    explanation: '192.168.0.0/16 är ett av de privata intervallen (tillsammans med 10.0.0.0/8 och 172.16.0.0/12).',
    hint: 'Det finns tre privata intervall: 10.x, 172.16–31.x och 192.168.x.',
    onWrong: 'Kontrollera andra oktetten: 172.15 är inte privat, 172.16–172.31 är det.',
  },
  {
    id: 'ipv4-2',
    conceptId: 'ipv4-addressing',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'INTERMEDIATE',
    prompt: 'Ett interface har adressen 192.168.1.130/26. Vilket nät tillhör det?',
    options: [
      { id: 'a', text: '192.168.1.128', correct: true },
      { id: 'b', text: '192.168.1.0', correct: false, misconception: 'Med /26 är blockstorleken 64 adresser, så .0-nätet slutar på .63. .130 ligger i nästa block.' },
      { id: 'c', text: '192.168.1.192', correct: false },
      { id: 'd', text: '192.168.1.64', correct: false },
    ],
    explanation: '/26 ger block om 64 adresser: .0, .64, .128, .192. 130 ligger i .128-blocket.',
    hint: 'Blockstorlek = 256 − 192 (maskens sista oktett).',
    onWrong: 'Räkna block: 0–63, 64–127, 128–191. Vilket block innehåller 130?',
  },

  // --- Subnet mask / subnetting ------------------------------------------
  {
    id: 'mask-1',
    conceptId: 'subnet-mask',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'FOUNDATION',
    prompt: 'Vad är /24 i decimal maskform?',
    options: [
      { id: 'a', text: '255.255.255.0', correct: true },
      { id: 'b', text: '255.255.0.0', correct: false, misconception: 'Det är /16. Prefixet 24 betyder 24 ettor.' },
      { id: 'c', text: '255.255.255.128', correct: false },
      { id: 'd', text: '255.255.255.240', correct: false },
    ],
    explanation: '/24 = 24 ettor = 255.255.255.0.',
    hint: 'Varje oktett är 8 bitar. 24 bitar = tre fulla oktetter.',
    onWrong: 'Räkna ettor: 8 + 8 + 8 = 24, alltså tre hela oktetter satta.',
  },
  {
    id: 'subnet-1',
    conceptId: 'subnetting',
    kind: 'SUBNETTING',
    difficulty: 'INTERMEDIATE',
    prompt: 'Nätet 10.0.0.0/24 delas i fyra lika stora subnät. Vilken broadcast-adress har det andra subnätet?',
    accepted: ['10.0.0.127'],
    explanation: '/26 ger fyra subnät med 64 adresser: .0, .64, .128, .192. Det andra subnätet är 10.0.0.64–127, broadcast .127.',
    hint: 'Fyra subnät kräver 2 bitar extra, alltså /26. Blockstorlek 64.',
    onWrong: 'Blocken blir 0–63, 64–127, 128–191, 192–255. Broadcast är sista adressen i blocket.',
  },
  {
    id: 'subnet-2',
    conceptId: 'subnetting',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'EXAM_LEVEL',
    prompt: 'Hur många användbara hostadresser finns i ett /28-nät?',
    options: [
      { id: 'a', text: '14', correct: true },
      { id: 'b', text: '16', correct: false, misconception: '16 är totalt antal adresser. Nät- och broadcastadressen får inte användas av hosts.' },
      { id: 'c', text: '30', correct: false },
      { id: 'd', text: '12', correct: false },
    ],
    explanation: '/28 ger 16 adresser, minus nät- och broadcastadress = 14 användbara.',
    hint: '2^(32−prefix) adresser totalt, minus två.',
    onWrong: '2^4 = 16 totalt. Dra bort nätadress och broadcast.',
  },

  // --- Ethernet / MAC / switching ----------------------------------------
  {
    id: 'mac-1',
    conceptId: 'mac-addressing',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'BEGINNER',
    prompt: 'Hur lång är en MAC-adress?',
    options: [
      { id: 'a', text: '48 bitar (6 byte)', correct: true },
      { id: 'b', text: '32 bitar (4 byte)', correct: false, misconception: '32 bitar är en IPv4-adress, inte en MAC-adress.' },
      { id: 'c', text: '64 bitar (8 byte)', correct: false },
      { id: 'd', text: '128 bitar (16 byte)', correct: false },
    ],
    explanation: 'En MAC-adress är 48 bitar, skriven som sex hexadecimala par.',
    hint: 'Räkna grupperna i AA:BB:CC:DD:EE:FF.',
    onWrong: 'Sex grupper om två hex-siffror = 6 × 8 = 48 bitar.',
  },
  {
    id: 'switch-1',
    conceptId: 'switching',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'INTERMEDIATE',
    prompt: 'En switch får ett paket till en MAC-adress som inte finns i MAC-adresstabellen. Vad gör den?',
    options: [
      { id: 'a', text: 'Floodar ramen ut på alla portar utom den inkommande', correct: true },
      { id: 'b', text: 'Kastar ramen', correct: false, misconception: 'En switch kastar bara ramen om den är korrupt eller om porten är blockerad – inte för att adressen är okänd.' },
      { id: 'c', text: 'Skickar den till default gateway', correct: false, misconception: 'En switch bryr sig inte om IP eller gateway; det är routerns jobb.' },
      { id: 'd', text: 'Frågar DNS', correct: false },
    ],
    explanation: 'Vid unknown unicast floodar switchen ramen och lär sig av svaret.',
    hint: 'Switchen vet inte var mottagaren är – vad är säkraste sättet att nå den?',
    onWrong: 'Okänd måladress = unknown unicast = flood.',
  },
  {
    id: 'arp-1',
    conceptId: 'arp',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'FOUNDATION',
    prompt: 'Vad gör ARP?',
    options: [
      { id: 'a', text: 'Hittar MAC-adressen som hör till en IP-adress i det lokala nätet', correct: true },
      { id: 'b', text: 'Hittar IP-adressen som hör till ett domännamn', correct: false, misconception: 'Namn till IP är DNS. ARP arbetar med IP till MAC.' },
      { id: 'c', text: 'Tilldelar IP-adresser automatiskt', correct: false, misconception: 'Automatisk adresstilldelning är DHCP.' },
      { id: 'd', text: 'Krypterar trafiken', correct: false },
    ],
    explanation: 'ARP kopplar en känd IP-adress till rätt MAC-adress på den lokala länken.',
    hint: 'Det handlar om två adresstyper: IP och MAC.',
    onWrong: 'DNS = namn→IP. ARP = IP→MAC.',
  },
  {
    id: 'vlan-1',
    conceptId: 'vlan',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'INTERMEDIATE',
    prompt: 'Vilken porttyp används för att bära trafik från flera VLAN mellan två switchar?',
    options: [
      { id: 'a', text: 'Trunk-port', correct: true },
      { id: 'b', text: 'Access-port', correct: false, misconception: 'En access-port tillhör ett enda VLAN och taggar inte trafiken.' },
      { id: 'c', text: 'Console-port', correct: false },
      { id: 'd', text: 'Routed port', correct: false },
    ],
    explanation: 'En trunk bär flera VLAN med 802.1Q-taggar.',
    hint: 'Vilken port måste kunna märka ramar med VLAN-id?',
    onWrong: 'Access = ett VLAN. Trunk = många VLAN med taggar.',
  },

  // --- Routing ------------------------------------------------------------
  {
    id: 'route-1',
    conceptId: 'routing',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'INTERMEDIATE',
    prompt: 'En router har två rutter till 10.1.0.0/16 och 10.1.5.0/24. Vilken används för paket till 10.1.5.10?',
    options: [
      { id: 'a', text: '10.1.5.0/24, eftersom den är mest specifik', correct: true },
      { id: 'b', text: '10.1.0.0/16, eftersom den kommer först', correct: false, misconception: 'Ordningen i tabellen avgör inte. Längsta prefix match vinner.' },
      { id: 'c', text: 'Båda, lastbalanserat', correct: false },
      { id: 'd', text: 'Ingen, paketet släpps', correct: false },
    ],
    explanation: 'Longest prefix match: /24 är mer specifik än /16 och vinner.',
    hint: 'Vilket prefix beskriver adressen mest exakt?',
    onWrong: 'Routern väljer alltid den mest specifika matchande ruten.',
  },
  {
    id: 'route-2',
    conceptId: 'static-routes',
    kind: 'SHORT_ANSWER',
    difficulty: 'INTERMEDIATE',
    prompt: 'Skriv kommandot (utan prompt) som sätter en default route mot 192.168.1.1 på en Cisco-router.',
    accepted: ['ip route 0.0.0.0 0.0.0.0 192.168.1.1', 'ip route 0.0.0.0 0.0.0.0 192.168.1.1 '],
    explanation: 'ip route 0.0.0.0 0.0.0.0 192.168.1.1',
    hint: 'Default route skrivs som nät 0.0.0.0 med mask 0.0.0.0.',
    onWrong: 'Formen är: ip route <nät> <mask> <next-hop>.',
  },

  // --- Services -----------------------------------------------------------
  {
    id: 'dhcp-1',
    conceptId: 'dhcp',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'FOUNDATION',
    prompt: 'I vilken ordning sker DHCP-processen?',
    options: [
      { id: 'a', text: 'Discover → Offer → Request → Acknowledge', correct: true },
      { id: 'b', text: 'Offer → Discover → Acknowledge → Request', correct: false, misconception: 'Klienten måste fråga först (Discover) innan servern kan erbjuda (Offer).' },
      { id: 'c', text: 'Request → Offer → Discover → Acknowledge', correct: false },
      { id: 'd', text: 'Discover → Request → Offer → Acknowledge', correct: false },
    ],
    explanation: 'DORA: Discover, Offer, Request, Acknowledge.',
    hint: 'Kom ihåg förkortningen DORA.',
    onWrong: 'Klienten börjar alltid med att ropa ut en förfrågan (Discover).',
  },
  {
    id: 'dns-1',
    conceptId: 'dns',
    kind: 'TRUE_FALSE_REASONING',
    difficulty: 'INTERMEDIATE',
    prompt: '"Om ping mot 8.8.8.8 fungerar men ping mot google.com misslyckas är DNS en trolig orsak." Sant eller falskt?',
    options: [
      { id: 'a', text: 'Sant – IP-trafik fungerar men namnet kan inte slås upp', correct: true },
      { id: 'b', text: 'Falskt – då är det alltid kabeln', correct: false, misconception: 'Om kabeln vore trasig skulle ping mot 8.8.8.8 också misslyckas.' },
    ],
    explanation: 'Att IP-adresser fungerar men namn inte tyder på namnuppslagning, alltså DNS.',
    hint: 'Vad skiljer de två kommandona? Det ena behöver namnuppslagning.',
    onWrong: 'Fungerande IP-ping isolerar felet till namnuppslagning.',
  },

  // --- Troubleshooting / CLI ---------------------------------------------
  {
    id: 'cli-1',
    conceptId: 'cli-config',
    kind: 'CLI_INTERPRET',
    difficulty: 'INTERMEDIATE',
    prompt: 'Vad säger den här utskriften om FastEthernet0/1?',
    context: `Router# show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
FastEthernet0/0        192.168.1.1     YES manual up                    up
FastEthernet0/1        unassigned      YES unset  administratively down down`,
    options: [
      { id: 'a', text: 'Porten är administrativt avstängd och saknar IP-adress', correct: true },
      { id: 'b', text: 'Porten är uppe men har fel IP-adress', correct: false, misconception: 'Status säger "administratively down", alltså är den stängd av konfigurationen.' },
      { id: 'c', text: 'Kabeln är trasig', correct: false, misconception: '"administratively down" är en konfigurationsfråga, inte ett kabelfel. Det syns som "down/down".' },
      { id: 'd', text: 'Porten är korrekt konfigurerad', correct: false },
    ],
    explanation: 'administratively down betyder att porten är shutdown. Dessutom är IP-adressen unassigned.',
    hint: 'Läs kolumnen Status ordagrant.',
    onWrong: 'administratively down = shutdown i konfigurationen. Åtgärd: no shutdown.',
  },
  {
    id: 'cli-2',
    conceptId: 'cli-config',
    kind: 'SHORT_ANSWER',
    difficulty: 'FOUNDATION',
    prompt: 'Vilket kommando visar MAC-adresstabellen på en Cisco-switch? (utan prompt)',
    accepted: ['show mac address-table', 'show mac-address-table'],
    explanation: 'show mac address-table',
    hint: 'Det börjar med show och handlar om MAC-adresser.',
    onWrong: 'Kommandot är show mac address-table.',
  },
  {
    id: 'trouble-1',
    conceptId: 'troubleshooting',
    kind: 'NETWORK_DIAGNOSIS',
    difficulty: 'EXAM_LEVEL',
    prompt: 'PC A (192.168.1.10/24) kan pinga PC B (192.168.1.20/24) men inte en server på 10.0.0.5. PC A:s default gateway är 192.168.1.1. Vad undersöker du först?',
    options: [
      { id: 'a', text: 'Om A kan pinga sin default gateway och om den har en route vidare', correct: true },
      { id: 'b', text: 'Om PC B:s MAC-adress är korrekt', correct: false, misconception: 'B fungerar redan. Felet ligger bortom det lokala nätet.' },
      { id: 'c', text: 'Om DNS är konfigurerad', correct: false, misconception: 'Du pingar en IP-adress, så DNS behövs inte för det testet.' },
      { id: 'd', text: 'Om kabeln till PC A är trasig', correct: false, misconception: 'PC A kommunicerar redan lokalt, så länken fungerar.' },
    ],
    explanation: 'Lokalt fungerar det. Nästa steg är gatewayen och routing vidare mot 10.0.0.0/24.',
    hint: 'Lokal kommunikation fungerar. Var tar trafiken vägen när målet ligger i ett annat nät?',
    onWrong: 'Felsök lager för lager utifrån vad som redan bevisats fungera.',
  },
  {
    id: 'icmp-1',
    conceptId: 'icmp',
    kind: 'MULTIPLE_CHOICE',
    difficulty: 'FOUNDATION',
    prompt: 'Vilken protokolltyp använder ping?',
    options: [
      { id: 'a', text: 'ICMP echo request / echo reply', correct: true },
      { id: 'b', text: 'TCP SYN', correct: false, misconception: 'TCP används av till exempel HTTP. Ping använder ICMP.' },
      { id: 'c', text: 'UDP', correct: false },
      { id: 'd', text: 'ARP request', correct: false },
    ],
    explanation: 'Ping skickar ICMP echo request och väntar på echo reply.',
    hint: 'Det är ett hjälpprotokoll på lager 3.',
    onWrong: 'Ping = ICMP, inte TCP eller UDP.',
  },
  {
    id: 'explain-1',
    conceptId: 'arp',
    kind: 'EXPLAIN_BACK',
    difficulty: 'INTERMEDIATE',
    prompt: 'Förklara med egna ord varför en dator behöver ARP innan den kan skicka en Ethernet-ram till en IP-adress i samma nät.',
    rubric: [
      'Nämner att Ethernet-ramen kräver en MAC-adress.',
      'Nämner att IP-adressen inte räcker för leverans på länken.',
      'Beskriver broadcast-frågan och svaret, eller ARP-cachen.',
    ],
    explanation: 'Ethernet levererar till MAC-adresser. IP-adressen säger vart paketet ska, men länken behöver en MAC-adress – ARP tar reda på den.',
    hint: 'Vad står i mottagaradressfältet på en Ethernet-ram?',
    onWrong: 'Utgå från ramens adressfält och vad det kräver.',
  },
];

export function questionById(id: string): Question | undefined {
  return QUESTIONS.find((q) => q.id === id);
}

export function byConcept(conceptId: string): Question[] {
  return QUESTIONS.filter((q) => q.conceptId === conceptId);
}
