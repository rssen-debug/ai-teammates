import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync('src/ui/app.js','utf8');
const config=fs.readFileSync('src/core/config.js','utf8');
const css=fs.readFileSync('src/ui/phoenix.css','utf8');
test('tap-to-talk does not require legacy wake word unless explicitly opted in',()=>{
 assert.match(app,/if\(wake && S\.st\?\.config\?\.ui\?\.voice\?\.requireWakeWord === true\)/);
 assert.match(config,/wakeWord: '', requireWakeWord: false/);
});
test('foreground voice gate is opt-in instead of rejecting normal manual speech',()=>{
 assert.match(app,/foregroundGate === true/);
 assert.match(config,/foregroundGate: false/);
});
test('recognized words still reach real chat turn',()=>{
 assert.match(app,/send\(command,\{voiceTurn:true\}\)/);
 assert.match(app,/voiceState\('thinking','Got it/);
});
test('voice caption remains readable in narrow composer',()=>{
 assert.match(css,/body\.simple #composer #voice-caption\{/);
 assert.match(css,/overflow-wrap:anywhere/);
});
