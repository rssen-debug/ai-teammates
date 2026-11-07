import { extractText, ExtractError } from '../v4/extract.js';

/** Rich PDF recovery runs locally inside the deterministic tool worker. */
export async function extractDriverDocument(bytes, fileName) {
  let basic;
  try { basic = extractText(bytes, { fileName }); }
  catch (error) {
    if (!['NO_TEXT_LAYER'].includes(error.code)) throw error;
    basic = { kind: 'pdf', confidence: 'partial', text: '', warning: error.message };
  }
  if (basic.kind !== 'pdf' || basic.confidence === 'text') return basic;
  const { default: PDFParser } = await import('pdf2json');
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    const timer = setTimeout(() => { parser.destroy(); reject(new ExtractError('PDF_TIMEOUT', 'PDF text extraction timed out')); }, 15000);
    parser.on('pdfParser_dataError', error => {
      clearTimeout(timer); parser.destroy();
      reject(new ExtractError('PDF_PARSE_FAILED', String(error.parserError?.message || error.parserError || 'PDF parsing failed')));
    });
    parser.on('pdfParser_dataReady', () => {
      clearTimeout(timer);
      const text = parser.getRawTextContent().replace(/-+Page \(\d+\) Break-+/g, '').trim();
      parser.destroy();
      if (!text) { reject(new ExtractError('NO_TEXT_LAYER', 'PDF has no extractable text layer; OCR is required')); return; }
      resolve({ kind: 'pdf', confidence: 'text', text, engine: 'pdf2json' });
    });
    // pdf2json assumes byteOffset 0 when a Buffer shares a pooled ArrayBuffer.
    // Copy into a dedicated allocation so short documents parse their own bytes.
    const input = Buffer.alloc(bytes.length); bytes.copy(input);
    try { parser.parseBuffer(input); }
    catch (error) { clearTimeout(timer); parser.destroy(); reject(new ExtractError('PDF_PARSE_FAILED', error.message)); }
  });
}
