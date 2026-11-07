import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('release publishing targets MAJINCLI and cannot overwrite a version tag', () => {
  const ps = read('scripts/publish.ps1');
  assert.match(ps, /\$Repo = 'rssen-debug\/MAJINCLI'/);
  assert.match(ps, /\$Branch = 'main'/);
  assert.doesNotMatch(ps, /git tag -f|git push -f/);
  assert.match(ps, /git push origin \$Tag/);
});

test('a pull request runs the real Windows build and smoke verifier without creating a release', () => {
  const wf = read('.github/workflows/build-exe.yml');
  assert.match(wf, /pull_request:\s*\n\s*branches: \[main\]/);
  assert.match(wf, /npm test/);
  assert.match(wf, /npm run check/);
  assert.match(wf, /build-on-windows\.ps1 -SkipBuild -Ci/);
  assert.match(wf, /if: \$\{\{ github\.event_name == 'workflow_dispatch'.*github\.event_name == 'push' \}\}/);
  assert.doesNotMatch(wf, /github\.com\/rssen-debug\/slurps\/releases/);
});


test('Windows verification prints version-safe publishing steps and never advertises an old repo', () => {
  const ps = read('scripts/build-on-windows.ps1');
  assert.doesNotMatch(ps, /rssen-debug\/slurps|v0\.1\.1|gh release create/, 'stale releases and wrong repo must never be recommended');
  assert.match(ps, /\$Ci\) \{[\s\S]{0,130}pull request does not publish a GitHub release/, 'CI smoke tests do not publish releases');
  assert.match(ps, /scripts\\publish\.ps1 -Version \$appVersion -Branch main/, 'publishing delegates to the existing safe script with current version');
  assert.match(ps, /Get-Content \(Join-Path \$root 'package\.json'\)/, 'version is read from package.json rather than hardcoded');
});

test('CI actions use maintained Node 24-based action releases', () => {
  const wf = read('.github/workflows/build-exe.yml');
  assert.doesNotMatch(wf, /checkout@v4|setup-node@v4/, 'Node 20 based GitHub actions are deprecated');
  assert.match(wf, /actions\/checkout@v5/);
  assert.match(wf, /actions\/setup-node@v6/);
});
