import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/ui/mindmap.js','utf8');
const app = fs.readFileSync('src/ui/app.js','utf8');
const html = fs.readFileSync('src/ui/index.html','utf8');
const context = { window: {} };
vm.runInNewContext(source, context, { timeout: 2000 });
test('mindmap renders connected nodes from an explicit outline', () => {
  const svg = context.window.MAJIN_MINDMAP.render('Root\n  - Branch\n    - Leaf');
  assert.match(svg, /<svg/);
  assert.equal((svg.match(/<rect /g) || []).length, 3);
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.match(svg, /Root/);
  assert.match(svg, /Branch/);
  assert.match(svg, /Leaf/);
});
test('mindmap escapes untrusted HTML and caps size', () => {
  const svg = context.window.MAJIN_MINDMAP.render('<img src=x onerror=alert(1)>\n' + Array(100).fill('  - node').join('\n'));
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /&lt;img/);
  assert.equal((svg.match(/<rect /g) || []).length, 32);
});
test('chat loads mindmap before app and renders explicit blocks', () => {
  assert.ok(html.indexOf('/mindmap.js') < html.indexOf('/app.js'));
  assert.match(app, /String\(_lang\)\.toLowerCase\(\) === 'mindmap'/);
  assert.match(app, /window\.MAJIN_MINDMAP\.render\(code\)/);
});
