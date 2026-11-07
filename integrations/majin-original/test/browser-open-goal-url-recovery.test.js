import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverExplicitBrowserUrl } from '../src/core/loop.js';

const url='http://127.0.0.1:35743/';
const prompt='On this LOCAL QA job portal ONLY '+url+', use browser.open, browser.fill, browser.click to tick consent and submit the fake form.';

test('real Qwen3B bug: a missing browser.open URL is recovered from ONE explicit current user URL',()=>{
  const r=recoverExplicitBrowserUrl(prompt,'browser.open',{});
  assert.ok(r,'the model sent browser.open({}) despite user providing a single URL');
  assert.equal(r.args.url,url);
  assert.equal(r.recovered,true);
  assert.match(r.reason,/explicit HTTP/);
});

test('recovered URL preserves other browser.open arguments and original input stays unmodified',()=>{
  const args={headless:true};
  const r=recoverExplicitBrowserUrl(prompt,'browser.open',args);
  assert.deepEqual(r.args,{headless:true,url});
  assert.deepEqual(args,{headless:true});
});

test('valid model-selected browser URL is never overridden',()=>{
  assert.equal(recoverExplicitBrowserUrl(prompt,'browser.open',{url:'https://example.org'}),null);
  assert.equal(recoverExplicitBrowserUrl(prompt,'browser.open',{url:' http://localhost:8000 '}),null);
});

test('ambiguous, missing and invalid destinations must never auto-navigate',()=>{
  const bad=[
    'Use browser.open on https://one.test and https://two.test.',
    'Use browser.open on https://first.test then a second page http://another.test.',
    'Use browser.open to find the company hiring page.',
    'Use browser.open on ftp://example.org/resource',
    'Use browser.open with http://user:secret@example.org/',
    'How do I use browser.open at https://example.org?',
  ];
  for(const p of bad)assert.equal(recoverExplicitBrowserUrl(p,'browser.open',{}),null,p);
});

test('the URL fallback never affects unrelated tools or user read-only contexts',()=>{
  for(const n of ['browser.read','browser.click','browser.fill','web.search','fs.write']){
    assert.equal(recoverExplicitBrowserUrl(prompt,n,{}),null,n);
  }
});

test('repeated occurrence of same explicit URL remains uniquely identifiable',()=>{
  const p='Use browser.open at '+url+' and then take a screenshot from '+url+'.';
  assert.equal(recoverExplicitBrowserUrl(p,'browser.open',{})?.args.url,url);
});
