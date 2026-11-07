import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/ui/voice-intent.js','utf8');
const app=fs.readFileSync('src/ui/app.js','utf8');
const html=fs.readFileSync('src/ui/index.html','utf8');
const ctx={window:{}};vm.runInNewContext(source,ctx,{timeout:1500});
const classify=(s,busy)=>ctx.window.MAJIN_VOICE_INTENT.classify(s,busy);
test('natural spoken interruption does not execute as normal task',()=>{
 for(const s of ['nej vänta','avbryt','stopp','wait','nej']){
  assert.equal(classify(s,true).kind,'cancel',s);
 }
});
test('spoken corrections yield a replacement goal while busy',()=>{
 assert.equal(classify('nej sök fyra IT-jobb',true).kind,'replace');
 assert.equal(classify('nej sök fyra IT-jobb',true).text,'sök fyra IT-jobb');
 assert.equal(classify('nej, gör en hemsida istället',true).text,'gör en hemsida istället');
 assert.equal(classify('nej sök fyra IT-jobb',false).kind,'send');
});
test('ordinary commands and contextual references remain available to agent',()=>{
 for(const s of ['öppna de fyra','ja dessa ser bra ut','skapa sidan','sök IT-jobb'])assert.equal(classify(s,true).kind,'send');
});
test('app supports listening while busy and awaits confirmed cancellation',()=>{
 assert.doesNotMatch(app,/if\(voiceFinished\|\|recog!==r\|\|!S\.handsFree\|\|S\.busy\)return/);
 assert.match(app,/await stopObservedTask\(S\.taskId,S\.session\)/);
 assert.match(app,/await send\(intent\.text,\{voiceTurn:true\}\)/);
 assert.ok(html.indexOf('/voice-intent.js')<html.indexOf('/app.js'));
});
