import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src=fs.readFileSync('src/ui/voice-foreground.js','utf8');
const env={window:{}};
vm.runInNewContext(src,env);
const Gate=env.window.MAJINForegroundVoiceGate;

test('stable background TV-level audio does not trigger foreground',()=>{
  const g=new Gate();
  let active=false;
  for(let i=0;i<50;i++)active=g.observe(0.025,1000+i*16);
  assert.equal(active,false);
  assert.equal(g.lastSpeech,0);
});
test('a short nearby voice burst over the established ambient baseline is detected',()=>{
  const g=new Gate();
  for(let i=0;i<25;i++)g.observe(.014,1000+i*16);
  for(let i=25;i<32;i++)g.observe(.09,1000+i*16);
  assert.equal(g.isForeground(1550),true);
  assert.ok(g.lastSpeech>0);
  assert.equal(g.isForeground(4000),false);
});
test('nonfinite sample cannot unlock foreground and reset clears enrollment',()=>{
  const g=new Gate();
  assert.equal(g.observe(NaN),false);
  for(let i=0;i<25;i++)g.observe(.01,100+i*20);
  for(let i=25;i<30;i++)g.observe(.09,100+i*20);
  g.reset();assert.equal(g.lastSpeech,0);assert.equal(g.isForeground(),false);
});
test('client actually uses foreground evidence before dispatching a voice turn',()=>{
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(app,/voiceGate\.observe\(rms\)/);
  assert.match(app,/Date\.now\(\)-voiceGate\.lastSpeech>4500/);
  assert.match(app,/Ignored — wake phrase not detected/);
  assert.match(html,/src="\/voice-foreground\.js"/);
});
