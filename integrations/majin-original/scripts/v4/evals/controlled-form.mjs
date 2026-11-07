// Controlled, non-public website for real-agent evaluation. No task planner here.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startControlledForm({ uploadText, port = 0 } = {}) {
  if (typeof uploadText !== 'string' || !uploadText.length) throw Error('Fixture upload text is required');
  const nonce = crypto.randomBytes(5).toString('hex');
  const expected = { group: `Orion-${nonce}`, email: `eval-${nonce}@example.invalid`, seats: '3', country: 'SE', slot: 'Late' };
  const state = { submissions: [], needsSlot: false, accepted: null };
  const receipt = `REG-${crypto.randomBytes(8).toString('hex')}`;
  const html = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Community Lab Signup</title>
<style>body{font:18px system-ui;max-width:600px;margin:2rem auto;padding:1rem}label{display:block;margin:1rem 0}input,select,button{font:inherit;padding:.5rem}#error{color:#9b2020}</style>
<h1>Community Lab Signup</h1><p>This is an isolated demo. No emails or real registrations are sent.</p>
<form id="signup-${nonce}">
<label>Participation <select name="participation" id="mode-${nonce}" required><option value="">Choose</option><option>Individual</option><option>Team</option></select></label>
<section id="contact-${nonce}"></section>
<label>Country <select name="country" id="country-${nonce}" required><option value="">Choose</option><option value="SE">Sweden</option><option value="GB">United Kingdom</option></select></label>
<section id="session-${nonce}"></section>
<label>Supporting document <input type="file" name="document" id="upload-${nonce}" accept=".txt" required></label>
<label><input type="checkbox" name="consent" id="consent-${nonce}" required> I agree to this local demo registration</label>
<button type="submit">Register</button><p id="error" role="alert"></p></form>
<section id="result" aria-live="polite"></section>
<script>
const form=document.querySelector('form'), mode=form.elements.participation;
let generation=0;
function contacts(previous={}) {
 generation++;
 document.querySelector('#contact-${nonce}').innerHTML=mode.value==='Team'
 ? '<fieldset><legend>Team contact</legend><label>Group name <input name="group" id="group-${nonce}-'+generation+'" required></label><label>Contact email <input type="email" name="email" id="email-${nonce}-'+generation+'" required></label><label>Attendees <input type="number" name="seats" id="seats-${nonce}-'+generation+'" min="2" max="8" value="0" required></label></fieldset>' : '';
 for (const key of ['group','email','seats']) if(form.elements[key]&&previous[key])form.elements[key].value=previous[key];
}
mode.addEventListener('change',()=>contacts());
form.addEventListener('submit',async(event)=>{
 event.preventDefault();
 const previous=Object.fromEntries(new FormData(form).entries());
 const response=await fetch('/submit',{method:'POST',body:new FormData(form)});
 const result=await response.json();
 if(!response.ok){
  document.querySelector('#error').textContent=result.message;
  if(result.needsSlot){
   contacts(previous);
   document.querySelector('#session-${nonce}').innerHTML='<label>Session <select name="slot" id="slot-${nonce}-'+generation+'" required><option value="">Choose</option><option>Early</option><option>Late</option></select></label>';
   form.elements.document.value='';
  }
  return;
 }
 document.title='Registration saved'; form.hidden=true;
 const h=document.createElement('h1'); h.textContent='Registration saved';
 const p=document.createElement('p');p.id='receipt';p.textContent='Receipt: '+result.receipt;
 document.querySelector('#result').append(h,p);history.pushState({},'', '/receipt');
});
</script></html>`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'" });
      res.end(html); return;
    }
    if (req.method === 'GET' && url.pathname === '/receipt' && state.accepted) {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<h1>Registration saved</h1><p>Receipt: ${receipt}</p>`); return;
    }
    if (req.method !== 'POST' || url.pathname !== '/submit') { send(404, { message: 'Not found' }); return; }
    if (state.accepted) { send(409, { message: 'This demo registration was already saved.' }); return; }
    if (state.submissions.length >= 8) { send(429, { message: 'Demo retry budget exhausted.' }); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) { send(413, { message: 'Demo upload is too large.' }); return; } chunks.push(chunk); }
      const data = await new Request('http://localhost/submit', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
      const uploaded = data.get('document');
      const text = uploaded && typeof uploaded.arrayBuffer === 'function' ? Buffer.from(await uploaded.arrayBuffer()).toString('utf8') : '';
      const values = Object.fromEntries(['participation','group','email','seats','country','slot','consent'].map(key => [key, data.get(key)]));
      const observed = { values, uploadBytes: Buffer.byteLength(text), uploadSha256: crypto.createHash('sha256').update(text).digest('hex'), userAgent: req.headers['user-agent'] || '', accepted: false };
      state.submissions.push(observed);
      if (values.participation !== 'Team' || values.group !== expected.group || values.email !== expected.email || values.seats !== expected.seats || values.country !== expected.country || !values.consent || text !== uploadText) {
        send(400, { message: 'Check the requested team contact, attendee count, country, consent and supporting document.' }); return;
      }
      if (!state.needsSlot) {
        state.needsSlot = true;
        send(422, { needsSlot: true, message: 'Please choose a session in the new field and attach the document again. Your contact details have been kept.' }); return;
      }
      if (values.slot !== expected.slot) { send(422, { message: 'Please choose the requested Late session.' }); return; }
      observed.accepted = true; state.accepted = { receipt, ...values, uploadSha256: observed.uploadSha256 };
      send(201, { receipt });
    } catch { if (!res.headersSent) send(400, { message: 'Invalid demo form upload.' }); else res.end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    expected,
    receipt,
    proof: () => structuredClone(state),
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
