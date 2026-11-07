import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync('src/ui/app.js','utf8');
const css=fs.readFileSync('src/ui/phoenix.css','utf8');
test('stalled model stream has a bounded failure instead of endless thinking',()=>{
 assert.match(app,/let streamTimedOut = false/);
 assert.match(app,/streamTimedOut = true; ac\.abort\(\)/);
 assert.match(app,/resetStreamWatchdog\(\)/);
 assert.match(app,/clearTimeout\(streamWatchdog\)/);
 assert.match(app,/The model stopped responding for 90 seconds/);
});
test('voice recognizer stays armed while MAJIN speaks and speech cancels playback',()=>{
 assert.doesNotMatch(app,/if\(speechActive\|\|!S\.handsFree\|\|recog\)return/);
 assert.match(app,/if\(speechActive\)\{[\s\S]*?speechSynthesis\?\.cancel\(\)/);
 assert.match(app,/Keep the conversation armed/);
});
test('speaking state remains visible without visual chatter',()=>{
 assert.match(css,/body\.simple\[data-voice-mode="speaking"\]/);
});

test('simple playback echo filtering avoids immediate self-trigger',()=>{
 assert.match(app,/function isVoicePlaybackEcho\(heard\)/);
 assert.match(app,/speechActive && isVoicePlaybackEcho\(words\)/);
 assert.match(app,/lastSpokenReply=clean/);
});
