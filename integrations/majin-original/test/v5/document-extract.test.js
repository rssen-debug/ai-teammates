import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDriverDocument } from '../../src/v5/document-extract.js';

// A custom CID font maps glyph identifiers to Unicode through ToUnicode.
// No personal document or third-party font is embedded in this fixture.
function pdf(content) {
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Test def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <004B> <0002> <00D6> <0003> <0052> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /CIDToGIDMap /Identity /FontDescriptor << /Type /FontDescriptor /FontName /Test /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >> >>',
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${i+1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(x => String(x).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

test('driver decodes custom CID font Unicode instead of returning glyph IDs', async () => {
  const result = await extractDriverDocument(pdf('BT /F1 12 Tf 20 200 Td <000100020003> Tj ET'), 'cv.pdf');
  assert.equal(result.confidence, 'text');
  assert.equal(result.engine, 'pdf2json');
  assert.match(result.text, /KÖR/);
});

test('driver reports an image-only PDF without inventing text', async () => {
  await assert.rejects(extractDriverDocument(pdf(''), 'scan.pdf'), { code: 'NO_TEXT_LAYER' });
});

test('driver preserves rejection of encrypted PDFs', async () => {
  await assert.rejects(extractDriverDocument(Buffer.from('%PDF-1.4\n/Encrypt 1 0 R\n%%EOF'), 'locked.pdf'), { code: 'ENCRYPTED' });
});
