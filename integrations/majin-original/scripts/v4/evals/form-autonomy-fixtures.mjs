// Four different acceptance sites; no tool selectors/actions are given to the model.
import http from 'node:http';
import crypto from 'node:crypto';
export async function startFormAutonomyFixture({kind,uploadText}){
 if(!['A','B','C'].includes(kind)||!uploadText)throw Error('Unknown fixture');
 const n=crypto.randomBytes(5).toString('hex'),receipt='ACCEPT-'+crypto.randomBytes(12).toString('hex');
 const expected={name:'Atlas '+n,email:'person-'+n+'@example.invalid',quantity:'4',country:'Sweden',category:'Workshop',consent:'on'};
 const state={requests:[],submissions:[],steps:[],accepted:null,challenge:false};
 const q=s=>JSON.stringify(s),id=name=>name+'-'+n;
 const input=(label,name,type='text',extra='')=>`<label for="${id(name)}">${label}</label><input id="${id(name)}" name="${name}" type="${type}" required ${extra}>`;
 const file=`<label>Application attachment<input name="document" type="file" accept=".txt" required></label>`;
 const consent=`<label><input name="consent" type="checkbox" required>Allow this isolated application</label>`;
 const contact=input('Applicant name','name')+input('Email address','email','email');
 const header=`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Safe ${kind} application</title><style>body{font:16px system-ui;max-width:620px;margin:24px auto;padding:12px}label,input,select,button{display:block;margin:8px 0;padding:6px}input[type=checkbox]{display:inline}fieldset{margin:12px 0}</style><h1>Local application ${kind}</h1><p>No external people or services are contacted.</p>`;
 let content,script='';
 if(kind==='A'){
  content=`<label id=category-label>Activity category</label><select aria-labelledby=category-label name=category required><option value="">Choose activity</option><option>Workshop</option><option>Tour</option></select><section id=dependent></section><label>Country<select name=country required><option value="">Choose country</option><option>Sweden</option><option>Norway</option></select></label>${file}${consent}<button type=submit>Save application</button>`;
  const dynamic=contact+input('Number of participants','quantity','number','min="2" max="10"');
  script=`document.querySelector('[name=category]').onchange=()=>{document.querySelector('#dependent').innerHTML=${q(dynamic)};const field=document.querySelector('[name=name]');field.addEventListener('input',e=>{if(!e.isTrusted)e.target.value=''})};`;
 }else if(kind==='B'){
  content=`<section id=step>${contact}<button type=submit>Continue to documents</button></section>`;
  script=`let step=1;form.addEventListener('submit',async e=>{e.preventDefault();const data=new FormData(form);data.set('step',String(step));const response=await fetch('/next',{method:'POST',body:data});const body=await response.json();if(!response.ok){alertBox.textContent=body.message;return}if(body.receipt){done(body);return}step++;document.querySelector('#step').innerHTML=step===2?${q(file+consent+'<button type=submit>Review application</button>')}:${q('<p>Documents retained. Review complete.</p><button type=submit>Confirm application</button>')};});`;
 }else{
  content=`${contact}${input('Number of participants','quantity','number','min="1" max="10"')}<section id=correction></section>${file}${consent}<button type=submit>Send application</button>`;
 }
 if(kind!=='B')script+=`form.addEventListener('submit',async e=>{e.preventDefault();const response=await fetch('/submit',{method:'POST',body:new FormData(form)});const body=await response.json();if(!response.ok){alertBox.textContent=body.message;if(body.challenge){document.querySelector('#correction').innerHTML=${q(input('Review phrase','phrase'))};form.elements.document.value='';const old=form.elements.name;const replacement=old.cloneNode();replacement.value=old.value;replacement.id+='-revised';old.replaceWith(replacement);document.querySelector('label[for="${id('name')}"]').htmlFor=replacement.id;}return}done(body)});`;
 const html=header+`<form id="application-${n}">${content}</form><p role=alert></p><section id=result></section><script>const form=document.querySelector('form'),alertBox=document.querySelector('[role=alert]');function done(body){form.hidden=true;alertBox.textContent='';document.title='Application accepted';document.querySelector('#result').textContent='Application accepted. Receipt: '+body.receipt;history.pushState({},'','/accepted')}${script}</script>`;
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');state.requests.push({method:req.method,path:url.pathname,origin:req.headers.origin||null});
  const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))};
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html','content-security-policy':"default-src 'self';script-src 'unsafe-inline';style-src 'unsafe-inline';connect-src 'self';form-action 'self'"});return res.end(html)}
  if(req.method==='GET'&&url.pathname==='/accepted'&&state.accepted){res.writeHead(200,{'content-type':'text/html'});return res.end('<h1>Application accepted</h1><p>Receipt: '+receipt+'</p>')}
  if(req.method!=='POST'||!['/submit','/next'].includes(url.pathname))return send(404,{message:'Not found'});
  if(state.accepted)return send(409,{message:'Already accepted; do not repeat submission'});
  if(state.submissions.length>=6)return send(429,{message:'Bounded fixture submission limit reached'});
  try{
   let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>512*1024)return send(413,{message:'Too large'});chunks.push(c)}
   const data=await new Request('http://localhost/submit',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}).formData();
   const values=Object.fromEntries([...data.entries()].filter(([,v])=>typeof v==='string'));
   const upload=data.get('document');const bytes=upload?.arrayBuffer?Buffer.from(await upload.arrayBuffer()):Buffer.alloc(0);
   const seen={values,uploadBytes:bytes.length,uploadSha256:crypto.createHash('sha256').update(bytes).digest('hex'),accepted:false,userAgent:req.headers['user-agent']};state.submissions.push(seen);
   if(kind==='B'){
    const step=Number(values.step);
    if(step!==state.steps.length+1)return send(409,{message:'Wrong wizard step; inspect current page'});
    if(step===1){if(values.name!==expected.name||values.email!==expected.email)return send(422,{message:'Correct applicant name and email address'});state.steps.push({step,values});return send(200,{next:true})}
    if(step===2){if(values.consent!=='on'||bytes.toString()!==uploadText)return send(422,{message:'Consent and the exact application attachment are required'});state.steps.push({step,values,uploadSha256:seen.uploadSha256});return send(200,{next:true})}
    if(step!==3)return send(400,{message:'Invalid step'});
    seen.values={...state.steps[0].values,...state.steps[1].values,...values};seen.uploadSha256=state.steps[1].uploadSha256;
   }else{
    const keys=kind==='A'?Object.keys(expected):['name','email','quantity','consent'];
    if(keys.some(k=>values[k]!==expected[k])||bytes.toString()!==uploadText)return send(422,{message:'Correct the requested fields, consent and exact application attachment'});
    if(kind==='C'&&!state.challenge){state.challenge=true;return send(422,{challenge:true,message:'Server review requires the new Review phrase field to contain CLEAR. Attach your document again and resubmit; applicant details were retained.'})}
    if(kind==='C'&&values.phrase!=='CLEAR')return send(422,{message:'Review phrase must contain CLEAR'});
   }
   seen.accepted=true;state.accepted={receipt,values:seen.values,uploadSha256:seen.uploadSha256};send(201,{receipt});
  }catch{send(400,{message:'Invalid multipart data'})}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {base:`http://127.0.0.1:${server.address().port}`,expected,receipt,
  task:`Complete the safe local application at http://127.0.0.1:${server.address().port}/ for applicant ${expected.name}, email ${expected.email}.${kind==='A'?' Activity category Workshop; country Sweden.':''}${kind!=='B'?' Number of participants 4.':''} Allow this isolated application. Read and correct any validation feedback and finish all steps.`,
  proof:()=>structuredClone(state),close:()=>new Promise(r=>{server.close(r);server.closeAllConnections()})};
}
