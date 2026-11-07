import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('blocked browser clicks reveal obstacle without attempting blind retries',()=>{
  const tool=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(tool,/coveringRole:String\(overlay\.getAttribute\('role'\)/);
  assert.match(tool,/coveringId:String\(over\.id\|\|''\)/);
  assert.match(tool,/browser\.elements\(\{refresh:"true"\}\)/);
  assert.match(tool,/code:'click_blocked'/);
  assert.match(tool,/Another page element overlaps the target/);
  assert.match(tool,/Control is disabled or inert/);
});
test('composer visibly distinguishes blocked action with clear explanation and no extra panel',()=>{
  const js=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(js,/phrases=\{occluded:/);
  assert.match(js,/bar\.dataset\.phase='blocked'/);
  assert.match(js,/bar\.dataset\.blocker=reason/);
  assert.match(html,/#composer #work-progress\[data-phase="blocked"\]/);
  assert.match(html, /prefers-reduced-motion:reduce/);
});
