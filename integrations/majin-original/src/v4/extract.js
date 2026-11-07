/**
 * MAJIN V4 — read text out of the documents people actually have.
 *
 * The reported scenario starts with "hitta mitt CV" — and a CV is a PDF or a
 * DOCX. Uploading the file without being able to read it makes the feature
 * cosmetic, so this module extracts the text.
 *
 * Both formats are containers, and neither extraction is magic:
 *
 *   DOCX  — a ZIP holding `word/document.xml`. The ZIP is parsed here from its
 *           own structures (no dependency); paragraphs and tabs become newlines
 *           and spaces, everything else is stripped.
 *
 *   PDF   — a sequence of objects with content streams. This reads uncompressed
 *           and Flate-compressed streams and resolves the text operators
 *           (`Tj`, `TJ`, `'`, `"`). That covers the overwhelming majority of
 *           text-based PDFs, including the ones Word and LibreOffice produce.
 *
 * What this does NOT do, and reports instead of guessing:
 *   - encrypted PDFs (refused: ENCRYPTED)
 *   - scanned/image-only PDFs (reported: NO_TEXT_LAYER — there is no text layer)
 *   - CID/Type0 fonts with a custom encoding map (reported as PARTIAL: the bytes
 *     come out as glyph ids, which are not characters)
 *   - layout: columns and tables come out in stream order, not visual order
 *
 * `confidence` carries that honestly: 'text' when ligatures resolved, 'partial'
 * when something was extracted but some glyphs could not be mapped. A caller
 * must not treat 'partial' as a clean read.
 */
import zlib from 'node:zlib';

export class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
  }
}

export const MAX_EXTRACT_BYTES = 2_000_000;

/* --------------------------------------------------------------- zip ----- */

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Read one file out of a ZIP buffer. Supports stored (0) and deflated (8),
 * which is what every Office container uses.
 */
export function unzipOne(buf, wantedName) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ExtractError('NOT_A_ZIP', 'file is too small to be a zip');
  // Scan backwards for the end-of-central-directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractError('NOT_A_ZIP', 'no zip central directory found');

  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i += 1) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== CDIR_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (name === wantedName) {
      if (localOffset + 30 > buf.length) throw new ExtractError('CORRUPT_ZIP', 'local header is outside the file');
      if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new ExtractError('CORRUPT_ZIP', 'bad local header');
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: MAX_EXTRACT_BYTES });
        } catch (err) {
          throw new ExtractError('CORRUPT_ZIP', `could not inflate ${wantedName}: ${err.message}`);
        }
      }
      throw new ExtractError('UNSUPPORTED_COMPRESSION', `zip compression method ${method} is not supported`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new ExtractError('NOT_FOUND_IN_ZIP', `${wantedName} is not in this container`);
}

/* -------------------------------------------------------------- docx ----- */

/** Turn WordprocessingML into readable text, preserving paragraphs. */
export function docxXmlToText(xml) {
  const text = String(xml || '');
  return text
    // a paragraph break is a real newline
    .replace(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g, (para) => `${para}\n`)
    // tabs and explicit breaks
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    // keep the characters inside <w:t>, drop every other tag
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, inner) => unescapeXml(inner))
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function extractDocx(buf) {
  let xml;
  try {
    xml = unzipOne(buf, 'word/document.xml');
  } catch (err) {
    if (err instanceof ExtractError && err.code === 'NOT_FOUND_IN_ZIP') {
      throw new ExtractError('NOT_A_DOCX', 'this zip has no word/document.xml (is it an .xlsx or a plain zip?)');
    }
    throw err;
  }
  const text = docxXmlToText(xml.toString('utf8'));
  if (!text) throw new ExtractError('NO_TEXT', 'the document contains no text');
  return { kind: 'docx', text, confidence: 'text' };
}

/** XLSX: shared strings plus the first sheet's values. */
export function extractXlsx(buf) {
  const shared = (() => {
    try {
      const xml = unzipOne(buf, 'xl/sharedStrings.xml').toString('utf8');
      return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
        .map((m) => [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(''))
        .filter(Boolean);
    } catch {
      return [];
    }
  })();

  let sheet = '';
  for (const name of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet.xml']) {
    try {
      sheet = unzipOne(buf, name).toString('utf8');
      break;
    } catch { /* try the next name */ }
  }
  if (!sheet) throw new ExtractError('NOT_AN_XLSX', 'no worksheet found in this container');

  const rows = [];
  for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const isShared = /t="s"/.test(c[1]);
      const v = (c[2].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const inline = (c[2].match(/<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/) || [])[1];
      if (inline != null) cells.push(unescapeXml(inline));
      else if (v == null) cells.push('');
      else if (isShared) cells.push(shared[Number(v)] ?? '');
      else cells.push(v);
    }
    if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
  }
  const text = rows.join('\n').trim();
  if (!text) throw new ExtractError('NO_TEXT', 'the spreadsheet contains no text');
  return { kind: 'xlsx', text, confidence: 'text' };
}

/* --------------------------------------------------------------- pdf ----- */

/**
 * Pull the raw content streams out of a PDF.
 *
 * A stream is `... stream <EOL> bytes endstream`. Whether the bytes are Flate
 * compressed depends on the dictionary that precedes `stream`.
 */
export function pdfStreams(buf) {
  const out = [];
  const hay = buf.toString('latin1'); // 1 byte per char keeps offsets exact
  let cursor = 0;
  for (;;) {
    const s = hay.indexOf('stream', cursor);
    if (s < 0) break;
    // skip "endstream"
    if (hay.slice(Math.max(0, s - 3), s) === 'end') {
      cursor = s + 6;
      continue;
    }
    let start = s + 6;
    if (hay[start] === '\r') start += 1;
    if (hay[start] === '\n') start += 1;
    const e = hay.indexOf('endstream', start);
    if (e < 0) break;
    const dict = hay.slice(Math.max(0, s - 400), s);
    const compressed = /\/FlateDecode/.test(dict);
    let raw = buf.subarray(start, e);
    if (compressed) {
      try {
        raw = zlib.inflateSync(raw, { maxOutputLength: MAX_EXTRACT_BYTES });
      } catch {
        cursor = e + 9;
        continue; // a stream we cannot inflate is skipped, not fatal
      }
    }
    out.push({ data: raw, compressed });
    cursor = e + 9;
  }
  return out;
}

/** Decode a PDF literal string, including the common escapes. */
export function pdfStringToText(raw) {
  const s = String(raw);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === 'n') { out += '\n'; i += 1; }
    else if (n === 'r') { out += '\r'; i += 1; }
    else if (n === 't') { out += '\t'; i += 1; }
    else if (n === 'b') { i += 1; }
    else if (n === 'f') { i += 1; }
    else if (n === '(') { out += '('; i += 1; }
    else if (n === ')') { out += ')'; i += 1; }
    else if (n === '\\') { out += '\\'; i += 1; }
    else if (/[0-7]/.test(n)) {
      const oct = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
      out += String.fromCharCode(parseInt(oct, 8));
      i += oct.length;
    } else if (n === '\n') { i += 1; }
    else { out += n ?? ''; i += 1; }
  }
  return out;
}

/** Text operators out of one decompressed content stream. */
export function pdfContentToText(content) {
  const src = String(content);
  const parts = [];
  // (literal) Tj  |  [(a) -2 (b)] TJ  |  (x) '  |  a b (x) "
  const re = /(?:\[((?:[^\][\\]|\\.)*)\]\s*TJ)|(?:\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|"))/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1] != null) {
      let piece = '';
      const inner = m[1];
      const sre = /\(((?:[^()\\]|\\.)*)\)/g;
      let sm;
      while ((sm = sre.exec(inner)) !== null) piece += pdfStringToText(sm[1]);
      parts.push(piece);
    } else if (m[2] != null) {
      parts.push(pdfStringToText(m[2]));
    }
  }
  // Td/TD/T* move the cursor; treat a run of them as a line break
  const text = parts.join('')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/** Heuristic: bytes outside printable ASCII suggest a custom font encoding. */
function looksLikeGlyphIds(text) {
  if (!text) return false;
  let odd = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x09 || (code > 0x0d && code < 0x20)) odd += 1;
    else if (code > 0x7e && code < 0xa0) odd += 1;
  }
  return odd / text.length > 0.15;
}

export function extractPdf(buf) {
  const head = buf.subarray(0, 5).toString('ascii');
  if (head !== '%PDF-') throw new ExtractError('NOT_A_PDF', 'the file does not start with %PDF-');
  if (/\/Encrypt\s/.test(buf.toString('latin1').slice(0, 20_000))) {
    throw new ExtractError('ENCRYPTED', 'this PDF is encrypted; remove the password and try again');
  }

  const streams = pdfStreams(buf);
  const chunks = [];
  for (const st of streams) {
    const text = pdfContentToText(st.data.toString('latin1'));
    if (text) chunks.push(text);
  }
  const text = chunks.join('\n\n').trim();

  if (!text) {
    throw new ExtractError(
      'NO_TEXT_LAYER',
      'no text could be read from this PDF. It is probably a scan (an image of a page) — OCR is not built in.',
    );
  }
  if (looksLikeGlyphIds(text)) {
    return {
      kind: 'pdf',
      text,
      confidence: 'partial',
      warning: 'some glyphs use a custom font encoding; the text above may contain wrong characters',
    };
  }
  return { kind: 'pdf', text, confidence: 'text' };
}

/* ----------------------------------------------------------- dispatch ----- */

/**
 * Extract text from a supported container.
 * @returns {{kind:string, text:string, confidence:'text'|'partial', warning?:string}}
 */
export function extractText(buf, { fileName = '' } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new ExtractError('EMPTY', 'the file is empty');
  if (buf.length > MAX_EXTRACT_BYTES) {
    throw new ExtractError('TOO_LARGE', `the file is larger than ${Math.floor(MAX_EXTRACT_BYTES / 1024)} kB`);
  }
  const ext = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';

  if (ext === 'pdf' || buf.subarray(0, 5).toString('ascii') === '%PDF-') return extractPdf(buf);
  if (ext === 'docx' || (buf[0] === 0x50 && buf[1] === 0x4b && ext !== 'xlsx')) {
    try {
      return extractDocx(buf);
    } catch (err) {
      if (ext === 'docx') throw err;
    }
  }
  if (ext === 'xlsx') return extractXlsx(buf);

  // plain text by extension or by content
  if (['txt', 'md', 'csv', 'json', 'log', 'xml', 'yml', 'yaml'].includes(ext)) {
    const text = buf.toString('utf8').trim();
    if (!text) throw new ExtractError('NO_TEXT', 'the file is empty');
    return { kind: ext, text, confidence: 'text' };
  }
  throw new ExtractError('UNSUPPORTED_FORMAT', `cannot read text from a .${ext || 'unknown'} file`);
}
