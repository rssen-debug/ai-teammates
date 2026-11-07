/* V1: regression tests for the chat scroller without a browser runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const match = app.match(/function scroll\(force = false\) \{[\s\S]*?\n\}/);
assert.ok(match, 'V1 scroll implementation must exist');

function run({ top, height, viewport, readingHistory = false, force = false }) {
  let writes = 0;
  const scroller = {
    scrollHeight: height,
    clientHeight: viewport,
    get scrollTop() { return top; },
    set scrollTop(value) { writes++; top = value; }
  };
  const S = { readingHistory };
  const $ = (id) => {
    assert.equal(id, 'scroller');
    return scroller;
  };
  const scroll = new Function('$', 'S', match[0] + '\nreturn scroll;')($, S);
  scroll(force);
  return { top, writes };
}

test('does not write when already at bottom', () => {
  assert.deepEqual(run({ top: 900, height: 1000, viewport: 100 }), { top: 900, writes: 0 });
});

test('follows new streamed content', () => {
  assert.deepEqual(run({ top: 900, height: 1100, viewport: 100 }), { top: 1100, writes: 1 });
});

test('preserves reading history unless forced', () => {
  assert.deepEqual(run({ top: 100, height: 1000, viewport: 100, readingHistory: true }), { top: 100, writes: 0 });
});

test('forced scrolling still writes after content shrinks', () => {
  assert.deepEqual(run({ top: 900, height: 600, viewport: 100, readingHistory: true, force: true }), { top: 600, writes: 1 });
});
