/* MAJIN — P2 (UI-agent handover 2026-10-19, deliver-in-order #3: adapter
   capacity + honest vision).
   V1: Anthropic adapter delivers image_url data: URLs as real image blocks
   V2: http(s) image sources map to url-source blocks; junk is dropped loudly
       (never silently — the model must know something was lost)
   V3: toAnthropic regressions guarded (strings stay strings, tool_use intact)
   V4: screen region math is x,y,w,h → left,top,RIGHT,BOTTOM (FromLTRB contract)
   V5: capture receipt is the BYTES: PNG magic required, invalid temp quarantined
   V6: PowerShell single-quote escaping; bad region values are told honestly */
import test from 'node:test';
import assert from 'node:assert/strict';

const { toAnthropic } = await import('../src/core/provider/anthropic.js');
const { ltrbFromRegion, psQuote, validatePngBytes } = await import('../src/core/tools/net.js');
const { bus } = await import('../src/core/log.js');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

test('V1: image_url data: URLs become Anthropic base64 image blocks — pixels actually cross the wire', () => {
  const { messages } = toAnthropic([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'text', text: 'what is on this screen?' }, { type: 'image_url', image_url: { url: DATA_URL } }] },
  ]);
  const user = messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(user.content), 'multimodal message stays a block array');
  const img = user.content.find((b) => b.type === 'image');
  assert.ok(img, 'an image block exists — previously it was silently dropped');
  assert.deepEqual(img.source, { type: 'base64', media_type: 'image/png', data: PNG_B64 });
  assert.ok(user.content.some((b) => b.type === 'text' && b.text === 'what is on this screen?'), 'text part preserved');
});

test('V2: http(s) images map to url-source; junk parts are dropped but COUNTED (never silent)', () => {
  const warnings = [];
  const off = bus.on ? bus.on('anthropic.parts-dropped', (e) => warnings.push(e)) : null;
  const { messages } = toAnthropic([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/shot.webp' } }, { type: 'nonsense_chunk', x: 1 }] },
  ]);
  const user = messages.find((m) => m.role === 'user');
  const img = user.content.find((b) => b.type === 'image');
  assert.ok(img && img.source.type === 'url' && img.source.url === 'https://example.com/shot.webp');
  assert.ok(warnings.length >= 1 && warnings[0].dropped >= 1, 'the drop is announced on the bus, not buried');
  if (off) off();
});

test('V3: regressions guarded — plain strings untouched, assistant tool_use intact, tool_result survives', () => {
  const { system, messages } = toAnthropic([
    { role: 'system', content: 'sys a' },
    { role: 'user', content: 'plain text user msg' },
    { role: 'assistant', content: 'call it', tool_calls: [{ id: 't1', name: 'fs.list', argsJson: '{"path":"."}' }] },
    { role: 'tool', tool_call_id: 't1', content: 'file listing here' },
  ]);
  assert.equal(system, 'sys a');
  const user = messages.find((m) => m.role === 'user');
  assert.equal(user.content, 'plain text user msg', 'string content stays a string (Anthropic accepts the short form)');
  const asst = messages.find((m) => m.role === 'assistant');
  assert.ok(asst.content.some((b) => b.type === 'tool_use' && b.name === 'fs.list' && b.id === 't1'));
  const tool = messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.ok(tool && tool.content[0].tool_use_id === 't1' && tool.content[0].content === 'file listing here');
});

test('V4: region math — FromLTRB gets RIGHT/BOTTOM, not width/height', () => {
  assert.deepEqual(ltrbFromRegion('10, 20, 300, 200'), [10, 20, 310, 220], 'x,y,w,h -> left,top,x+w,y+h');
  assert.deepEqual(ltrbFromRegion('0,0,1920,1080'), [0, 0, 1920, 1080]);
  assert.equal(ltrbFromRegion('10'), null, 'too few parts');
  assert.equal(ltrbFromRegion('a,b,c,d'), null, 'non-numeric');
  assert.equal(ltrbFromRegion('5,5,0,100'), null, 'zero width rejected');
  assert.equal(ltrbFromRegion('5,5,10,-4'), null, 'negative height rejected');
});

test('V5: a capture receipt requires PNG magic bytes — garbage heads truthfully fail', () => {
  const pngHead = Buffer.from(PNG_B64, 'base64').subarray(0, 8);
  assert.equal(validatePngBytes(pngHead), true, 'real PNG magic passes');
  assert.equal(validatePngBytes(Buffer.from('<!doctyp')), false, 'HTML is not a screenshot');
  assert.equal(validatePngBytes(Buffer.from('GPaint')), false, 'random bytes rejected');
  assert.equal(validatePngBytes(Buffer.alloc(3)), false, 'truncated files rejected');
});

test('V6: PowerShell quoting escapes single quotes (path cannot break the command string)', () => {
  assert.equal(psQuote("C:\\shots\\it's here.png"), "'C:\\shots\\it''s here.png'");
  assert.equal(psQuote('plain.png'), "'plain.png'");
});
