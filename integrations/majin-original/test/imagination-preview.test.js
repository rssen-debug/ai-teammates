import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FILE = path.resolve(import.meta.dirname, '../src/ui/imagine.js');

function harness() {
  let networkCalls = 0;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.className = '';
      this.children = [];
      this.dataset = {};
      this.attrs = {};
      this.hidden = false;
      this.parentNode = null;
      this._text = '';
      this.classList = {
        add: (...names) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          names.forEach((name) => set.add(name));
          this.className = [...set].join(' ');
        },
        remove: (...names) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          names.forEach((name) => set.delete(name));
          this.className = [...set].join(' ');
        },
      };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map((el) => el.textContent).join(''); }
    append(...items) { items.forEach((e) => { e.parentNode = this; this.children.push(e); }); }
    prepend(...items) { items.forEach((e) => { e.parentNode = this; this.children.unshift(e); }); }
    insertBefore(el, at) {
      el.parentNode = this;
      const i = this.children.indexOf(at);
      this.children.splice(i < 0 ? this.children.length : i, 0, el);
    }
    remove() { if (!this.parentNode) return; const a = this.parentNode.children; const i = a.indexOf(this); if (i >= 0) a.splice(i, 1); this.parentNode = null; }
    setAttribute(name, value) { this.attrs[name] = value; }
    querySelector(selector) {
      if (selector.startsWith('.')) return this.find((e) => e.className.split(/\s+/).includes(selector.slice(1)));
      return null;
    }
    find(pred) {
      for (const child of this.children) {
        if (pred(child)) return child;
        const nested = child.find(pred);
        if (nested) return nested;
      }
      return null;
    }
    scrollIntoView() {}
  }
  const root = new Element('section');
  const document = { readyState: 'complete', getElementById: (id) => id === 'imagine' ? root : null, createElement: (t) => new Element(t) };
  const window = { __MAJIN_TOKEN__: 'dev-test' };
  const fetch = async () => {
    networkCalls += 1;
    return { ok: true, headers: { get: () => '32' }, text: async () => '<h1>Preview works</h1><script>alert(1)</script>' };
  };
  vm.runInNewContext(fs.readFileSync(FILE, 'utf8'), { window, document, TextEncoder, fetch, Date, JSON, String, Number, Map, Set }, { filename: FILE });
  return { root, window, get networkCalls() { return networkCalls; } };
}

test('parallel tools complete on their own rows, even out of order', () => {
  const { root, window } = harness();
  const vision = window.MAJIN_IMAGINE;
  vision.onEvent({ type: 'tool', name: 'fs.write' });
  vision.onEvent({ type: 'tool', name: 'fs.write' });
  vision.onEvent({ type: 'tool_begin', name: 'fs.write', callId: 'a' });
  vision.onEvent({ type: 'tool_begin', name: 'fs.write', callId: 'b' });
  vision.onEvent({ type: 'tool_result', tool: 'fs.write', callId: 'b', ok: false, error: { message: 'disk full' } });
  const stepRows = root.find((el) => el.className === 'steps').children;
  assert.equal(stepRows.length, 2, 'a proposed tool and a started tool are the same row');
  assert.match(stepRows[1].className, /fail/);
  assert.match(stepRows[0].className, /running/);
  vision.onEvent({ type: 'tool_result', tool: 'fs.write', callId: 'a', ok: true, summary: 'wrote a.html' });
  assert.match(stepRows[0].className, /ok/);
  assert.match(stepRows[0].textContent, /wrote a.html/);
  assert.match(stepRows[1].textContent, /disk full/);
});

test('HTML preview is opt-in, sandboxed and needs no model or network calls before click', async () => {
  const h = harness();
  const v = h.window.MAJIN_IMAGINE;
  v.onEvent({ type: 'tool_begin', name: 'fs.write', callId: 'a' });
  v.onEvent({ type: 'tool_result', tool: 'fs.write', callId: 'a', ok: true, meta: { path: 'index.html', bytes: 46 } });
  assert.equal(h.networkCalls, 0);
  const button = h.root.find((el) => el.className === 'preview-action');
  assert.ok(button, 'an actual HTML file offers a preview');
  await button.onclick();
  assert.equal(h.networkCalls, 1);
  const frame = h.root.find((el) => el.tagName === 'iframe');
  assert.equal(frame.attrs.sandbox, '', 'scripts and same-origin access are disabled');
  assert.equal(frame.attrs.referrerpolicy, 'no-referrer');
  assert.match(frame.srcdoc, /default-src 'none'/);
  assert.match(frame.srcdoc, /Preview works/);
});

test('non-HTML and oversized tool outputs do not get preview buttons', () => {
  const h = harness(), v = h.window.MAJIN_IMAGINE;
  v.onEvent({ type: 'tool_result', tool: 'fs.write', ok: true, meta: { path: 'data.txt', bytes: 12 } });
  v.onEvent({ type: 'tool_result', tool: 'fs.write', ok: true, meta: { path: 'large.html', bytes: 800000 } });
  assert.equal(h.root.find((el) => el.className === 'preview-action'), null);
});

test('reset clears prior tool associations and preview state', () => {
  const h = harness(), v = h.window.MAJIN_IMAGINE;
  v.onEvent({ type: 'tool_begin', name: 'fs.write', callId: 'a' });
  v.reset();
  v.onEvent({ type: 'tool_result', tool: 'fs.write', callId: 'a', ok: true, summary: 'new task' });
  const rows = h.root.find((el) => el.className === 'steps').children;
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /new task/);
});
