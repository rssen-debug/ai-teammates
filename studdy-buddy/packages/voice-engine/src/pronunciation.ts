/**
 * Pronunciation preprocessing for technical networking text.
 *
 * TTS engines read "192.168.1.1" as a number, "10.0.0.0/24" as "ten point zero
 * point zero point zero slash twenty four", and "Fa0/1" as gibberish. This
 * module rewrites a sentence into something a Swedish or English narrator can
 * actually say, *without* changing what is displayed on screen.
 *
 * The mapping is explicit and testable; we never rely on the provider's notion
 * of how to read a dotted quad.
 */

export type Language = 'sv-SE' | 'en-US';

export interface PronunciationOptions {
  language: Language;
  /** "ip" reads octets separately; "number" reads it as a decimal number. */
  ipStyle?: 'octets' | 'number';
}

const DIGIT_WORDS_SV = ['noll', 'ett', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio'];
const DIGIT_WORDS_EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const LETTER_WORDS: Record<string, { sv: string; en: string }> = {
  a: { sv: 'a', en: 'a' },
  b: { sv: 'be', en: 'bee' },
  c: { sv: 'se', en: 'see' },
  d: { sv: 'de', en: 'dee' },
  e: { sv: 'e', en: 'ee' },
  f: { sv: 'eff', en: 'eff' },
  g: { sv: 'ge', en: 'gee' },
  h: { sv: 'hå', en: 'aitch' },
  i: { sv: 'i', en: 'eye' },
  j: { sv: 'ji', en: 'jay' },
  k: { sv: 'kå', en: 'kay' },
  l: { sv: 'ell', en: 'ell' },
  m: { sv: 'emm', en: 'em' },
  n: { sv: 'enn', en: 'en' },
  o: { sv: 'o', en: 'oh' },
  p: { sv: 'pe', en: 'pee' },
  q: { sv: 'ku', en: 'cue' },
  r: { sv: 'ärr', en: 'ar' },
  s: { sv: 'ess', en: 'ess' },
  t: { sv: 'te', en: 'tee' },
  u: { sv: 'u', en: 'you' },
  v: { sv: 've', en: 'vee' },
  w: { sv: 'dubbel-ve', en: 'double-u' },
  x: { sv: 'ex', en: 'ex' },
  y: { sv: 'y', en: 'why' },
  z: { sv: 'säta', en: 'zee' },
};

/** Acronyms spoken letter by letter, with the form each language actually uses. */
const ACRONYMS: Record<string, { sv: string; en: string }> = {
  OSI: { sv: 'o ess i', en: 'O S I' },
  ARP: { sv: 'a ärr pe', en: 'A R P' },
  DHCP: { sv: 'de se hå pe', en: 'D H C P' },
  DNS: { sv: 'de enn ess', en: 'D N S' },
  VLAN: { sv: 've lan', en: 'vee lan' },
  TCP: { sv: 'te se pe', en: 'T C P' },
  UDP: { sv: 'u de pe', en: 'U D P' },
  ICMP: { sv: 'i se em pe', en: 'I C M P' },
  MAC: { sv: 'mack', en: 'mack' },
  IP: { sv: 'i pe', en: 'I P' },
  CIDR: { sv: 'si-i-de-ärr', en: 'cider' },
  LAN: { sv: 'lan', en: 'lan' },
  WAN: { sv: 'van', en: 'wan' },
  IOS: { sv: 'i o ess', en: 'eye-oh-ess' },
};

const DIGITS_SV = DIGIT_WORDS_SV;
const DIGITS_EN = DIGIT_WORDS_EN;

function digitsSpoken(digits: string, language: Language): string {
  const table = language === 'sv-SE' ? DIGITS_SV : DIGITS_EN;
  return digits
    .split('')
    .map((d) => table[Number(d)] ?? d)
    .join(' ');
}

/** Spells a short alphanumeric token ("Fa0/1", "Gi0/2") letter by letter. */
export function spellToken(token: string, language: Language): string {
  const parts: string[] = [];
  for (const char of token) {
    if (/[0-9]/.test(char)) {
      parts.push(digitsSpoken(char, language));
    } else if (char === '/') {
      parts.push(language === 'sv-SE' ? 'snedstreck' : 'slash');
    } else if (char === '.') {
      parts.push(language === 'sv-SE' ? 'punkt' : 'dot');
    } else if (/[a-zA-Z]/.test(char)) {
      const entry = LETTER_WORDS[char.toLowerCase()];
      parts.push(entry ? entry[language === 'sv-SE' ? 'sv' : 'en'] : char);
    }
  }
  return parts.join(' ');
}

export function spokenIp(ip: string, language: Language): string {
  return ip.split('.').map((octet) => digitsSpoken(octet, language)).join(language === 'sv-SE' ? ' punkt ' : ' dot ');
}

export function spokenMac(mac: string, language: Language): string {
  // MAC addresses are hexadecimal; read the letters as letters.
  return mac
    .split(/[:\-.]/)
    .filter(Boolean)
    .map((group) => spellToken(group, language))
    .join(language === 'sv-SE' ? ' bindestreck ' : ' dash ');
}

/**
 * Rewrites text for speech. The order of substitutions matters: longer,
 * more specific patterns are replaced before generic numbers.
 */
export function toSpokenText(text: string, options: PronunciationOptions): string {
  const language = options.language;
  let out = text;

  // 1. CIDR notation: 10.0.0.0/24 -> "10.0.0.0 snedstreck 24"
  out = out.replace(/\b(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\b/g, (_m, ip: string, prefix: string) => {
    const spoken = options.ipStyle === 'number' ? digitsSpoken(prefix, language) : prefix;
    const slash = language === 'sv-SE' ? ' snedstreck ' : ' slash ';
    return `${spokenIp(ip, language)}${slash}${spoken}`;
  });

  // 2. Subnet masks and plain IPs.
  out = out.replace(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g, (m) => spokenIp(m, language));

  // 3. MAC addresses (colon, dash or Cisco dotted form).
  out = out.replace(/\b([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\b/gi, (m) => spokenMac(m, language));
  out = out.replace(/\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/gi, (m) => spokenMac(m, language));

  // 4. Interface names: Fa0/1, Gi0/0/1, S0/0/0.
  out = out.replace(/\b((?:Fa|Gi|Se|Eth|Gig|Fast)\d+(?:\/\d+)+)\b/g, (m) => spellToken(m, language));

  // 5. Acronyms.
  for (const [acronym, forms] of Object.entries(ACRONYMS)) {
    const re = new RegExp(`\\b${acronym}\\b`, 'g');
    out = out.replace(re, forms[language === 'sv-SE' ? 'sv' : 'en']);
  }

  // 6. CLI commands: keep the words, but spell interface tokens inside them.
  out = out.replace(/\b(show\s+[a-z\-\s]+)/gi, (m) => m.replace(/\s+/g, ' '));

  // 7. Normalise whitespace created by substitutions.
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Splits text into speakable chunks at sentence boundaries, so long answers can
 * be streamed to a TTS provider without exceeding per-request limits.
 */
export function chunkForSpeech(text: string, maxChars = 900): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
