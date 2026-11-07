import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, Config, DEFAULTS } from '../src/core/config.js';
import { routeFor } from '../src/core/router.js';
import { complete } from '../src/core/provider/chat.js';
import { responsesInput } from '../src/core/provider/responses.js';

function config(model) {
  const data = clone(DEFAULTS);
  data.providers.opencode.apiKey = 'test-go-secret';
  data.models.routes.chat = 'opencode/' + model;
  return new Config(data);
}

test('Go routes GLM, Qwen and Grok through the correct documented protocol', () => {
  const cases = [
    ['glm-5.3-flash','openai','/chat/completions'],
    ['qwen3.8-flash','anthropic','/messages'],
    ['minimax-m3','anthropic','/messages'],
    ['grok-4.6','responses','/responses'],
    ['gpt-6-luna','responses','/responses'],
    ['deepseek-v4.1-flash','openai','/chat/completions'],
  ];
  for (const [model, kind, endpoint] of cases) {
    const r = routeFor(config(model), 'chat', { session: 'go-protocol-test' });
    assert.equal(r.providerName, 'opencode');
    assert.equal(r.model, model);
    assert.equal(r.kind, kind);
    assert.equal(r.endpoint, 'https://opencode.ai/zen/go/v1' + endpoint);
  }
});

test('Go session is stable per conversation but distinct between conversations', () => {
  const cfg = config('qwen3.8-flash');
  const first = routeFor(cfg, 'chat', {session: 'chat-one'});
  const second = routeFor(cfg, 'chat', {session: 'chat-one'});
  const third = routeFor(cfg, 'chat', {session: 'chat-two'});
  assert.equal(first.extraHeaders['x-opencode-session'], second.extraHeaders['x-opencode-session']);
  assert.notEqual(first.extraHeaders['x-opencode-session'], third.extraHeaders['x-opencode-session']);
  assert.notEqual(first.extraHeaders['x-opencode-session'], 'chat-one');
  assert.ok(first.extraHeaders['x-opencode-session'].startsWith('ses_'));
  assert.match(first.extraHeaders['user-agent'], /MAJIN/);
});

test('Qwen Go sends native Anthropic Messages with session header and tools', async () => {
  const r = routeFor(config('qwen3.8-flash'), 'chat', {session:'qa-qwen-go'});
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent={url,options};
    return new Response(JSON.stringify({
      id:'msg_test',content:[{type:'text',text:'I will call echo'},{type:'tool_use',id:'tool_q',name:'qa_echo',input:{text:'HELLO'}}],
      usage:{input_tokens:10,output_tokens:20},stop_reason:'tool_use',
    }),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const out = await complete({
      route:r,messages:[{role:'user',content:'Call echo'}],
      tools:[{name:'qa_echo',description:'Echo',parameters:{type:'object',properties:{text:{type:'string'}}}}],
      maxTokens:100,temperature:0,retries:0,
    });
    assert.equal(sent.url, 'https://opencode.ai/zen/go/v1/messages');
    assert.equal(sent.options.headers['x-opencode-session'], r.extraHeaders['x-opencode-session']);
    assert.equal(sent.options.headers['user-agent'], 'MAJIN-coding-agent/1.0');
    assert.equal(sent.options.headers['x-api-key'], 'test-go-secret');
    const body = JSON.parse(sent.options.body);
    assert.equal(body.stream,false);
    assert.equal(body.model,'qwen3.8-flash');
    assert.equal(body.tools[0].name,'qa_echo');
    assert.equal(out.toolCalls[0].name,'qa_echo');
    assert.deepEqual(JSON.parse(out.toolCalls[0].argsJson),{text:'HELLO'});
  } finally {globalThis.fetch=original;}
});

test('Anthropic stream requests tolerate a gateway that answers with plain JSON', async () => {
  const r = routeFor(config('qwen3.8-flash'), 'chat', {session:'qa-qwen-json-stream'});
  const original = globalThis.fetch;
  const events = [];
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = {url, options};
    return new Response(JSON.stringify({
      id:'msg_json_stream',content:[{type:'text',text:'Calling echo'},{type:'tool_use',id:'tool_json',name:'qa_echo',input:{text:'STREAMED'}}],
      usage:{input_tokens:8,output_tokens:6},stop_reason:'tool_use',
    }),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const out = await complete({
      route:r,messages:[{role:'user',content:'Call echo'}],
      tools:[{name:'qa_echo',description:'Echo',parameters:{type:'object',properties:{text:{type:'string'}}}}],
      stream:true,maxTokens:100,temperature:0,retries:0,onEvent:event=>events.push(event),
    });
    assert.equal(JSON.parse(sent.options.body).stream,true);
    assert.equal(out.text,'Calling echo');
    assert.equal(out.toolCalls[0].name,'qa_echo');
    assert.deepEqual(JSON.parse(out.toolCalls[0].argsJson),{text:'STREAMED'});
    assert.deepEqual(events,[{type:'delta',text:'Calling echo'},{type:'tool',name:'qa_echo'}]);
  } finally {globalThis.fetch=original;}
});

test('Responses API encodes tool replay and decodes function calls for Go Grok', async () => {
  const r = routeFor(config('grok-4.6'), 'chat', {session:'qa-grok-go'});
  const original=globalThis.fetch;
  let sent;
  globalThis.fetch=async (url,options)=>{
    sent={url,options};
    return new Response(JSON.stringify({
      id:'resp_test',model:'grok-4.6',status:'completed',
      output:[{type:'function_call',call_id:'call_x',name:'qa_echo',arguments:'{"text":"HELLO"}'}],
      usage:{input_tokens:14,output_tokens:7},
    }),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const messages=[
      {role:'system',content:'Help safely'},
      {role:'user',content:'Call echo'},
      {role:'assistant',content:'',tool_calls:[{id:'old_call',name:'qa_echo',args:{text:'old'}}]},
      {role:'tool',tool_call_id:'old_call',content:'old response'},
      {role:'user',content:'Again'},
    ];
    const parsed = responsesInput(messages);
    assert.ok(parsed.some(x=>x.type==='function_call'&&x.call_id==='old_call'));
    assert.ok(parsed.some(x=>x.type==='function_call_output'&&x.call_id==='old_call'));
    const output=await complete({
      route:r,messages,
      tools:[{name:'qa_echo',description:'Echo',parameters:{type:'object',properties:{text:{type:'string'}}}}],
      maxTokens:100,temperature:0,retries:0,
    });
    assert.equal(sent.url,'https://opencode.ai/zen/go/v1/responses');
    assert.equal(sent.options.headers.authorization,'Bearer test-go-secret');
    assert.equal(sent.options.headers['x-opencode-session'],r.extraHeaders['x-opencode-session']);
    const body=JSON.parse(sent.options.body);
    assert.equal(body.model,'grok-4.6');
    assert.ok(body.input.some(x=>x.type==='function_call_output'));
    assert.equal(body.tools[0].name,'qa_echo');
    assert.equal(output.stopReason,'tool_calls');
    assert.equal(output.toolCalls[0].id,'call_x');
    assert.deepEqual(JSON.parse(output.toolCalls[0].argsJson),{text:'HELLO'});
  }finally{globalThis.fetch=original;}
});

test('Responses stream captures text and completed tool-call arguments', async () => {
  const r=routeFor(config('grok-4.6'),'chat',{session:'stream-test'});
  const events=[];
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{
    const completed={
      id:'resp_1',status:'completed',
      output:[{type:'message',content:[{type:'output_text',text:'Done '}]},
        {type:'function_call',call_id:'call_abc',name:'qa_echo',arguments:'{"text":"DONE"}'}],
      usage:{input_tokens:9,output_tokens:5},
    };
    const records=[
      {type:'response.output_text.delta',delta:'Done '},
      {type:'response.output_item.added',output_index:1,item:{type:'function_call',call_id:'call_abc',name:'qa_echo',arguments:''}},
      {type:'response.function_call_arguments.delta',output_index:1,delta:'{"text":"DONE"}'},
      {type:'response.completed',response:completed},
    ];
    const text=records.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n';
    return new Response(text,{status:200,headers:{'content-type':'text/event-stream'}});
  };
  try{
    const output=await complete({route:r,messages:[{role:'user',content:'call echo'}],
      tools:[{name:'qa_echo',description:'Echo',parameters:{type:'object',properties:{text:{type:'string'}}}}],
      stream:true,retries:0,onEvent:e=>events.push(e),
    });
    assert.equal(output.text,'Done ');
    assert.equal(output.toolCalls.length,1);
    assert.equal(output.toolCalls[0].argsJson,'{"text":"DONE"}');
    assert.equal(events.filter(e=>e.type==='delta').length,1,'canonical SSE completion must not double-emit streamed text');
    assert.deepEqual(events.filter(e=>e.type==='tool'),[{type:'tool',name:'qa_echo'}],'stream consumers must learn once that a tool call is being prepared');
  }finally{globalThis.fetch=original;}
});

test('Responses refuses empty and failed results rather than claiming success', async () => {
  const r=routeFor(config('grok-4.6'),'chat');
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({id:'empty',status:'completed',output:[]}),{status:200});
  try {
    await assert.rejects(
      complete({route:r,messages:[{role:'user',content:'say hello'}],stream:false,retries:0}),
      e=>e.code==='empty_response',
    );
  }finally{globalThis.fetch=original;}
});

test('Go GPT reasoning model omits unsupported temperature and replays serialized tool arguments', async () => {
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'completed', output_text: 'Done' }), { status: 200 });
  };
  try {
    await complete({ route: routeFor(config('gpt-6-luna'), 'chat'), stream: false, retries: 0,
      messages: [{ role: 'user', content: 'Continue' },
        { role: 'assistant', tool_calls: [{ id: 'call1', name: 'fs_read', argsJson: '{"path":"proof.txt"}' }] },
        { role: 'tool', tool_call_id: 'call1', content: 'proof' }] });
    assert.equal('temperature' in body, false);
    assert.equal(body.input.find(row => row.type === 'function_call').arguments, '{"path":"proof.txt"}');
  } finally { globalThis.fetch = original; }
});
