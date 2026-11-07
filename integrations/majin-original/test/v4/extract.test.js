/**
 * Reading a CV: PDF and DOCX text extraction.
 *
 * The fixtures are built in the test, byte for byte, so this proves the parser
 * against real container structures rather than against a hand-made stub.
 */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import test from 'node:test';
import {
  ExtractError, docxXmlToText, extractDocx, extractPdf, extractText, extractXlsx,
  pdfContentToText, pdfStreams, pdfStringToText, unzipOne,
} from '../../src/v4/extract.js';

/* --------------------------------------------------------- zip builder -- */

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(0, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cenBuf, eocd]);
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Anna Andersson</w:t></w:r></w:p>
    <w:p><w:r><w:t>Backend-utvecklare</w:t></w:r><w:r><w:tab/><w:t>Malmö</w:t></w:r></w:p>
    <w:p><w:r><w:t>Erfarenhet: 6 år med Node.js &amp; PostgreSQL</w:t></w:r></w:p>
  </w:body>
</w:document>`;

function makeDocx(xml = DOCUMENT_XML) {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': xml,
  });
}

/** A minimal but structurally real PDF with a Flate-compressed text stream. */
function makePdf(lines, { compress = true, encrypted = false } = {}) {
  const body = lines.map((l) => `BT /F1 12 Tf 72 720 Td (${l}) Tj ET`).join('\n');
  const stream = compress ? zlib.deflateSync(Buffer.from(body, 'latin1')) : Buffer.from(body, 'latin1');
  const dict = `<< /Length ${stream.length}${compress ? ' /Filter /FlateDecode' : ''} >>`;
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n${dict}\nstream\n`,
  ];
  // A real encrypted PDF marks it in the trailer: /Encrypt <ref> inside trailer.
  const tail = [
    '\nendstream\nendobj\n',
    encrypted
      ? '5 0 obj\n<< /Filter /Standard /V 2 /R 3 >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n'
      : '%%EOF\n',
  ];
  return Buffer.concat([
    Buffer.from(parts.join(''), 'latin1'),
    stream,
    Buffer.from(tail.join(''), 'latin1'),
  ]);
}

/* ---------------------------------------------------------------- zip -- */

test('extract/zip: reads a deflated entry out of a real container', () => {
  const buf = zip({ 'a.txt': 'hej', 'word/document.xml': DOCUMENT_XML });
  assert.equal(unzipOne(buf, 'a.txt').toString('utf8'), 'hej');
  assert.equal(unzipOne(buf, 'word/document.xml').toString('utf8'), DOCUMENT_XML);
  assert.throws(() => unzipOne(buf, 'saknas.txt'), (e) => e.code === 'NOT_FOUND_IN_ZIP');
});

test('extract/zip: a buffer that is not a zip is refused, not misparsed', () => {
  assert.throws(() => unzipOne(Buffer.from('bara text, ingen zip alls'), 'x'), (e) => e.code === 'NOT_A_ZIP');
});

/* --------------------------------------------------------------- docx -- */

test('extract/docx: a CV becomes readable text with paragraphs intact', () => {
  const { kind, text, confidence } = extractDocx(makeDocx());
  assert.equal(kind, 'docx');
  assert.equal(confidence, 'text');
  assert.match(text, /Anna Andersson/);
  assert.match(text, /Backend-utvecklare/);
  assert.match(text, /Malmö/);
  assert.match(text, /6 år med Node\.js & PostgreSQL/, 'entities are decoded');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'three paragraphs, three lines');
});

test('extract/docx: tabs and breaks are preserved, other markup is dropped', () => {
  const xml = '<w:p><w:r><w:t>Kolumn A</w:t><w:tab/><w:t>Kolumn B</w:t><w:br/><w:t>Rad 2</w:t></w:r></w:p>';
  const text = docxXmlToText(xml).trim();
  assert.equal(text, 'Kolumn A\tKolumn B\nRad 2');
});

test('extract/docx: a zip without word/document.xml says so instead of guessing', () => {
  assert.throws(() => extractDocx(zip({ 'readme.txt': 'hej' })), (e) => e.code === 'NOT_A_DOCX');
});

test('extract/docx: an empty document is reported, not returned as an empty string', () => {
  assert.throws(() => extractDocx(makeDocx('<w:document><w:body></w:body></w:document>')), (e) => e.code === 'NO_TEXT');
});

test('extract/xlsx: shared strings and cell values become a table', () => {
  const buf = zip({
    'xl/sharedStrings.xml': '<sst><si><t>Namn</t></si><si><t>Roll</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
      + '<row><c t="s"><v>0</v></c><c><v>42</v></c></row>'
      + '</sheetData></worksheet>',
  });
  const { text } = extractXlsx(buf);
  assert.equal(text, 'Namn\tRoll\nNamn\t42');
});

/* ---------------------------------------------------------------- pdf -- */

test('extract/pdf: text is recovered from a Flate-compressed content stream', () => {
  const buf = makePdf(['Anna Andersson', 'Backend-utvecklare, Malmo', 'Node.js och PostgreSQL']);
  const { kind, text, confidence } = extractPdf(buf);
  assert.equal(kind, 'pdf');
  assert.equal(confidence, 'text');
  assert.match(text, /Anna Andersson/);
  assert.match(text, /Backend-utvecklare, Malmo/);
  assert.match(text, /Node\.js och PostgreSQL/);
});

test('extract/pdf: an uncompressed stream works too', () => {
  const { text } = extractPdf(makePdf(['Hej fran en okomprimerad PDF'], { compress: false }));
  assert.match(text, /Hej fran en okomprimerad PDF/);
});

test('extract/pdf: TJ arrays and escaped characters are decoded', () => {
  const content = 'BT [(An) -20 (na)] TJ (\\() Tj (slut\\)) Tj ET';
  const text = pdfContentToText(content);
  assert.match(text, /Anna/);
  assert.match(text, /\(/);
  assert.match(text, /\)/);
  assert.equal(pdfStringToText('rad\\nbrott'), 'rad\nbrott');
  assert.equal(pdfStringToText('\\101\\102'), 'AB');
});

test('extract/pdf: an encrypted PDF is refused with a clear reason', () => {
  assert.throws(() => extractPdf(makePdf(['hemlig'], { encrypted: true })), (e) => e.code === 'ENCRYPTED');
});

test('extract/pdf: a scan with no text layer is reported as such, never as empty success', () => {
  const noText = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 10 >>\nstream\n', 'latin1'),
    Buffer.from('\nQ Q Q Q Q Q\n', 'latin1'),
    Buffer.from('endstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
  assert.throws(() => extractPdf(noText), (e) => e.code === 'NO_TEXT_LAYER' && /scan|OCR/i.test(e.message));
});

test('extract/pdf: something that is not a PDF is refused', () => {
  assert.throws(() => extractPdf(Buffer.from('hej')), (e) => e.code === 'NOT_A_PDF');
});

test('extract/pdf: streams are found and inflated', () => {
  const streams = pdfStreams(makePdf(['test']));
  assert.ok(streams.length >= 1);
  assert.ok(streams[0].compressed);
  assert.match(streams[0].data.toString('latin1'), /\(test\) Tj/);
});

/* ----------------------------------------------------------- dispatch -- */

test('extract: the dispatcher picks the right parser from the extension or the bytes', () => {
  assert.equal(extractText(makeDocx(), { fileName: 'cv.docx' }).kind, 'docx');
  assert.equal(extractText(makePdf(['x']), { fileName: 'cv.pdf' }).kind, 'pdf');
  assert.equal(extractText(Buffer.from('ren text'), { fileName: 'cv.txt' }).kind, 'txt');
  assert.equal(extractText(Buffer.from('{"a":1}'), { fileName: 'data.json' }).kind, 'json');
  // magic bytes win over a wrong extension
  assert.equal(extractText(makePdf(['x']), { fileName: 'fel.docx' }).kind, 'pdf');
});

test('extract: unsupported, empty and oversized input is refused with a code', () => {
  assert.throws(() => extractText(Buffer.from('x'), { fileName: 'a.png' }), (e) => e.code === 'UNSUPPORTED_FORMAT');
  assert.throws(() => extractText(Buffer.alloc(0), { fileName: 'a.txt' }), (e) => e.code === 'EMPTY');
  assert.throws(
    () => extractText(Buffer.alloc(3_000_000, 0x41), { fileName: 'a.txt' }),
    (e) => e.code === 'TOO_LARGE',
  );
  assert.ok(ExtractError.prototype instanceof Error);
});

/* -------------------------------------------- the scenario, end to end -- */

test('scenario: a CV uploaded from the phone can be read by the agent', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const { tempHome } = await import('./helpers.mjs');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();

    // 1. the phone uploads a DOCX CV
    const cv = makeDocx();
    const up = await fetch(`${s.base}/api/upload`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({
        name: 'cv.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: cv.toString('base64'),
      }),
    });
    assert.equal(up.status, 201, await up.clone().text());
    const uploadBody = await up.json();
    assert.equal(uploadBody.upload.readable, true, 'the upload declares that it can be read');
    assert.equal(uploadBody.upload.textKind, 'docx');
    assert.ok(uploadBody.upload.textChars > 30);

    // 2. the agent reads it with the ordinary tool, through the ordinary runner
    const { runTool } = await import('../../src/v2/tools/runner.js');
    const out = await runTool({ tool: 'document_read', input: { fileName: 'cv.docx' } }, {
      registry: s.context.tools.registry,
      approvals: { check: () => ({ decision: 'allow' }) },
      timeoutMs: 10_000,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.match(out.data.text, /Anna Andersson/);
    assert.match(out.data.text, /Backend-utvecklare/);
    assert.equal(out.data.confidence, 'text');

    // 3. and a PDF CV uploaded the same way
    const pdf = makePdf(['Kalle Karlsson', 'Systemutvecklare, Lund']);
    const up2 = await fetch(`${s.base}/api/upload`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ name: 'cv.pdf', type: 'application/pdf', data: pdf.toString('base64') }),
    });
    assert.equal(up2.status, 201);
    const out2 = await runTool({ tool: 'document_read', input: { fileName: 'cv.pdf' } }, {
      registry: s.context.tools.registry,
      approvals: { check: () => ({ decision: 'allow' }) },
      timeoutMs: 10_000,
    });
    assert.equal(out2.ok, true, JSON.stringify(out2));
    assert.match(out2.data.text, /Kalle Karlsson/);
    assert.match(out2.data.text, /Systemutvecklare, Lund/);

    // 4. the tool is offered to the model
    assert.ok(s.context.tools.schemas().some((x) => x.name === 'document_read'));
  } finally {
    await s.close();
    fsMod.rmSync(home, { recursive: true, force: true });
  }
});

test('scenario: a scanned PDF is refused honestly rather than reported as read', async () => {
  const { startTestServer, tempHome } = await import('./helpers.mjs');
  const fsMod = await import('node:fs');
  const home = tempHome();
  const s = await startTestServer({ home });
  try {
    const { cookie } = await s.pair();
    const scan = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 8 >>\nstream\n', 'latin1'),
      Buffer.from('\nQ Q Q Q\n', 'latin1'),
      Buffer.from('endstream\nendobj\n%%EOF\n', 'latin1'),
    ]);
    const up = await fetch(`${s.base}/api/upload`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ name: 'scan.pdf', type: 'application/pdf', data: scan.toString('base64') }),
    });
    assert.equal(up.status, 201, 'the upload itself is fine');
    const body = await up.json();
    assert.equal(body.upload.readable, false);
    assert.equal(body.upload.readError, 'NO_TEXT_LAYER');
    assert.match(body.upload.readNote, /scan|OCR/i);

    const { runTool } = await import('../../src/v2/tools/runner.js');
    await assert.rejects(
      () => runTool({ tool: 'document_read', input: { fileName: 'scan.pdf' } }, {
        registry: s.context.tools.registry,
        approvals: { check: () => ({ decision: 'allow' }) },
        timeoutMs: 10_000,
      }),
      (err) => /NO_TEXT_LAYER/.test(err.message),
      'reading a scan must fail loudly, not return an empty document',
    );
  } finally {
    await s.close();
    fsMod.rmSync(home, { recursive: true, force: true });
  }
});
