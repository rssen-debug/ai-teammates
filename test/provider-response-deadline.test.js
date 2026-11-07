import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set before importing the transport, which reads env at module load.
process.env.MAJIN_LLM_LOCAL_TIMEOUT = '170';
process.env.MAJIN_LLM_TIMEOUT = '170';
const { openaiStream, openaiOnce } = await import('../src/core/provider/openai.js');

const route = { providerName:'Ollama fixture', model:'qa-model',
  endpoint:'http://127.0.0.1:11434/v1/chat/completions', apiKey:'fixture' };

function stalledResponse(signal, streaming=true) {
  let aborted=false;
  const stream = new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => {
        aborted = true;
        controller.error(new Error('fake transport aborted by signal'));
      },{once:true});
    }
  });
  return { response: new Response(stream,{status:200,headers:{'content-type':streaming?'text/event-stream':'application/json'}}),
    wasAborted:()=>aborted };
}

test('provider abort deadline covers silent SSE body AFTER HTTP 200 headers', async () => {
  const prev=globalThis.fetch;
  let state;
  globalThis.fetch=async (_url, opts)=>{
    state=stalledResponse(opts.signal,true);
    return state.response;
  };
  try {
    const started=Date.now();
    await assert.rejects(() => openaiStream({route,
      messages:[{role:'user',content:'Do something'}],tools:[],maxTokens:32,temperature:0.1}),
      e => e.code==='model_timeout' && /timed out/.test(e.message));
    assert.ok(state.wasAborted(),'stream response never got an abort signal');
    assert.ok(Date.now()-started<4000,'request must finish in bounded time');
  } finally {globalThis.fetch=prev;}
});

test('provider abort deadline also covers stalled JSON response body',async()=>{
  const prev=globalThis.fetch;
  let state;
  globalThis.fetch=async (_url,opts)=>{
    state=stalledResponse(opts.signal,false);
    return state.response;
  };
  try {
    await assert.rejects(()=>openaiOnce({route,messages:[{role:'user',content:'Hi'}],
      maxTokens:10,temperature:0.1}),
      e=>e.code==='model_timeout');
    assert.ok(state.wasAborted());
  } finally {globalThis.fetch=prev;}
});

test('user-cancel abort is NOT misreported as model deadline',async()=>{
  const prev=globalThis.fetch;
  const control=new AbortController();
  globalThis.fetch=async (_url,opts)=>stalledResponse(opts.signal,true).response;
  const stop=setTimeout(()=>control.abort(new Error('user_cancelled')),35);
  try {
    await assert.rejects(()=>openaiStream({route,signal:control.signal,
      messages:[{role:'user',content:'Hi'}],maxTokens:10,temperature:0.1}),
      e=>e.code!=='model_timeout');
  } finally {clearTimeout(stop);globalThis.fetch=prev;}
});

test('regular successful streaming still returns contents and tool calls',async()=>{
  const prev=globalThis.fetch;
  const encoder=new TextEncoder();
  const stream=new ReadableStream({
    start(controller){
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"working"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" done"},"finish_reason":"stop"}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  globalThis.fetch=async()=>new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}});
  try {
    const result=await openaiStream({route,messages:[{role:'user',content:'Hi'}],maxTokens:15,temperature:0.1});
    assert.equal(result.text,'working done');
    assert.deepEqual(result.toolCalls,[]);
  } finally {globalThis.fetch=prev;}
});
