/**
 * MAJIN V2 Studio — operator surface, inline single-file page.
 *
 * Zero external assets BY CONSTRUCTION: the tool-approval rule for this
 * project forbids CDN scripts/styles/fonts (they would also break the
 * offline/Windows-first story). Everything the page needs ships in this
 * string. Read-only: the scaffold observes; operator WRITE actions arrive in
 * a later lane behind the existing consent gate (never silently here).
 */

export const STUDIO_REVISION = 'studio-scaffold.r1'; // not product semver — the single VERSION literal rule lives in src/core/version.js

export function renderStudioPage({ title = 'MAJIN V2 Studio', enableWrites = false, enableGoals = false, enableVoice = false, enableBundle = false, enableDoctor = false } = {}) {
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:dark;--bg:#0b0e12;--panel:#12161d;--line:#232a35;--fg:#d7dde6;--dim:#8b95a3;--ok:#3fcf8e;--bad:#f26d6d;--warn:#e8b44a;--accent:#5aa2ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline}
header h1{font-size:16px;margin:0;color:var(--accent)}
header .tag{color:var(--dim);font-size:12px}
main{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 16px}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;min-height:180px}
section h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:0 0 8px}
#audit .ok{color:var(--ok)} #audit .broken{color:var(--bad)}
#audit .head{color:var(--dim);word-break:break-all;font-size:11px}
#events{grid-column:1/-1;max-height:44vh;overflow:auto}
.row{font-size:12px;border-bottom:1px solid var(--line);padding:3px 0;display:flex;gap:8px}
.row .t{color:var(--dim);white-space:nowrap}
.row .k{color:var(--accent);min-width:140px}
.row .p{color:var(--fg);opacity:.85;word-break:break-all}
.kv{display:flex;justify-content:space-between;font-size:12px;border-bottom:1px solid var(--line);padding:3px 0}
.kv span:last-child{color:var(--accent)}
#conn{font-size:11px;color:var(--warn)}
#conn.live{color:var(--ok)}
.empty{color:var(--dim);font-size:12px}
#consent{grid-column:1/-1}
#consent .mode{font-size:12px;margin-bottom:8px}
#consent .mode.on{color:var(--warn)}
#consent .mode.off{color:var(--dim)}
#consent .form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:8px}
#consent label{font-size:11px;color:var(--dim);display:flex;flex-direction:column;gap:2px}
#consent input,#consent select{background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--fg);padding:4px 6px;font:inherit;font-size:12px}
#consent button{background:var(--accent);border:0;border-radius:4px;color:#0b0e12;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;font-weight:600}
#consent button[disabled]{opacity:.4;cursor:not-allowed}
#consent button.danger{background:var(--bad)}
#consent button.danger.armed{outline:2px solid var(--warn)}
#consent .rowform{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
#c-result,#c-status-out{font-size:12px;margin-top:6px;white-space:pre-wrap;word-break:break-all}
#c-result.err{color:var(--bad)} #c-result.ok2{color:var(--ok)}
#receipts{grid-column:1/-1;max-height:32vh;overflow:auto}
#goals{grid-column:1/-1}
#voice{grid-column:1/-1}
#voice input[type=text],#voice input:not([type]){background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--fg);padding:4px 6px;font:inherit;font-size:12px}
#voice button{background:var(--accent);border:0;border-radius:4px;color:#0b0e12;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;font-weight:600}
#bundle{grid-column:1/-1}
#bundle button{background:var(--accent);border:0;border-radius:4px;color:#0b0e12;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;font-weight:600;margin-right:8px}
#bundle pre{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px;font-size:12px;white-space:pre-wrap;max-height:180px;overflow:auto}
#doctor{grid-column:1/-1}
#doctor button{background:var(--accent);border:0;border-radius:4px;color:#0b0e12;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;font-weight:600}
#doctor pre{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px;font-size:12px;white-space:pre-wrap;max-height:240px;overflow:auto}
#voice audio{width:100%;margin-top:6px}
#v-out.err,#v-transcript.err{color:var(--bad)} #v-out.ok2,#v-transcript.ok2{color:var(--ok)}
#goals input{background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--fg);padding:4px 6px;font:inherit;font-size:12px}
#goals button{background:var(--accent);border:0;border-radius:4px;color:#0b0e12;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;font-weight:600}
#g-out.err{color:var(--bad)} #g-out.ok2{color:var(--ok)}
#receipts input{background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--fg);padding:4px 6px;font:inherit;font-size:12px}
#receipts button{background:var(--accent);border:0;border-radius:4px;color:#0b0e12;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;font-weight:600}
.rcpt{display:flex;gap:8px;font-size:12px;border-bottom:1px solid var(--line);padding:3px 0;align-items:baseline}
.rcpt .v{color:var(--ok);font-weight:700}
.rcpt .u{color:var(--warn)}
.rcpt .act{color:var(--fg);min-width:150px}
.rcpt .gid{color:var(--dim)}
.rcpt .h{color:var(--dim);font-size:11px}
</style>
</head>
<body>
<header>
  <h1>MAJIN V2 Studio</h1>
  <span class="tag">read-only scaffold ${STUDIO_REVISION} · observing real kernel surfaces</span>
  <span id="conn">connecting…</span>
</header>
<main>
  <section id="audit">
    <h2>Audit chain</h2>
    <div id="audit-body" class="empty">loading…</div>
  </section>
  <section id="telemetry">
    <h2>Telemetry (7 days)</h2>
    <div id="telemetry-body" class="empty">loading…</div>
  </section>
  <section id="consent">
    <h2>Consent</h2>
    <div id="consent-mode" class="mode ${enableWrites ? 'on">consent writes ENABLED — every grant/revoke lands in the audit chain' : 'off">read-only — consent writes disabled (no affordances shown; silence means NO)'}</div>
    <div class="form" id="consent-formwrap" ${enableWrites ? '' : 'hidden'}>
      <label>exact scope (Scoped Grant — nothing wider is ever granted)<input id="c-scope" placeholder="voice:external" maxlength="256"></label>
      <label>operator (named human — no self-consent)<input id="c-user" placeholder="your name" maxlength="64"></label>
      <label>mode <select id="c-mode"><option value="once" selected>once</option><option value="limited">limited</option><option value="session">session</option></select></label>
      <label>max uses <input id="c-maxuses" type="number" value="1" min="1" max="99"></label>
      <label>ttl seconds (0 = no expiry) <input id="c-ttl" type="number" value="0" min="0"></label>
      <button id="c-grant" type="button">Grant this exact scope</button>
    </div>
    <div id="c-result"></div>
    <div class="rowform" ${enableWrites ? '' : 'hidden'}>
      <input id="c-status-scope" placeholder="scope to inspect" maxlength="256" style="flex:1;min-width:180px">
      <button id="c-status" type="button">Check status</button>
      <button id="c-revoke" type="button" class="danger">Revoke</button>
    </div>
    <div id="c-status-out"></div>
  </section>
  <section id="voice">
    <h2>Voice</h2>
    <div class="mode ${enableVoice ? 'on">voice ENABLED — external providers pay voice:external consent per call; evidence is sha256-verified, never provider claims' : 'off">voice disabled (start with --enable-voice --voice-dir; disabled means SILENCE)'}</div>
    <div ${enableVoice ? '' : 'hidden'}>
      <div class="rowform">
        <input id="v-text" placeholder="text to speak (max 4000 chars)" maxlength="4000" style="flex:1;min-width:200px">
        <button id="v-speak" type="button">Speak</button>
      </div>
      <div id="v-out" style="font-size:12px;margin-top:6px;white-space:pre-wrap"></div>
      <div class="rowform" style="margin-top:8px">
        <label style="font-size:11px;color:var(--dim)">listen: choose a WAV file <input id="v-file" type="file" accept=".wav,audio/wav"></label>
        <button id="v-listen" type="button">Transcribe</button>
      </div>
      <div id="v-transcript" style="font-size:12px;margin-top:6px;white-space:pre-wrap"></div>
    </div>
  </section>
  <section id="doctor">
    <h2>Doctor</h2>
    <div class="mode ${enableDoctor ? 'on">doctor panel ENABLED — every row is a real probe on THIS machine; secrets render as fingerprints only' : 'off">doctor panel disabled (start with --enable-doctor-panel; disabled means NO probe)'}</div>
    <div ${enableDoctor ? '' : 'hidden'}>
      <button id="d-run" type="button">Run preflight</button>
      <pre id="d-out" style="display:none"></pre>
    </div>
  </section>
  <section id="bundle">
    <h2>Evidence dossier</h2>
    <div class="mode ${enableBundle ? 'on">bundle export ENABLED — portable dossier writes to the operator-fixed --bundle-dir only; destination paths from the client are never honoured' : 'off">bundle surface disabled (start with --bundle-dir; disabled means NO dossier)'}</div>
    <div ${enableBundle ? '' : 'hidden'}>
      <button id="b-export" type="button">Export dossier</button>
      <button id="b-verify" type="button">Verify dossier</button>
      <pre id="b-verdict" style="display:none"></pre>
    </div>
  </section>
  <section id="goals">
    <h2>Goal runs</h2>
    <div class="mode ${enableGoals ? 'on">goal runs ENABLED — every run consumes one studio:run-goals consent grant' : 'off">goal runs disabled (start with --enable-goals to unlock; disabled means NO runs)'}</div>
    <div class="rowform" ${enableGoals ? '' : 'hidden'}>
      <input id="g-objective" placeholder="objective (runs in the operator-fixed workspace only)" maxlength="2000" style="flex:1;min-width:220px">
      <button id="g-run" type="button">Run objective</button>
    </div>
    <div id="g-out" style="font-size:12px;margin-top:6px;white-space:pre-wrap"></div>
  </section>
  <section id="receipts">
    <h2>Receipts (from the tamper-evident chain)</h2>
    <div class="rowform" style="margin-bottom:6px">
      <input id="r-goal" placeholder="filter goalId (optional)" maxlength="64" style="flex:1;min-width:140px">
      <button id="r-refresh" type="button">Refresh</button>
    </div>
    <div id="receipts-body" class="empty">loading…</div>
  </section>
  <section id="events">
    <h2>Live events</h2>
    <div id="events-body"><div class="empty">waiting for events…</div></div>
  </section>
</main>
<script>
(function(){
  var MAX_ROWS = 200;
  var conn = document.getElementById('conn');
  var evBody = document.getElementById('events-body');

  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

  fetch('/api/audit/verify').then(function(r){return r.json()}).then(function(v){
    var b=document.getElementById('audit-body');
    b.className='';
    if(v.ok){
      b.innerHTML='<div class="ok">AUDIT ok — '+v.entries+' entries</div>'+
        '<div class="head">head '+esc((v.head||'').slice(0,32))+'…</div>';
    } else {
      b.innerHTML='<div class="broken">AUDIT broken — line '+esc(v.brokenAt)+' reason '+esc(v.reason)+'</div>'+
        '<div class="head">'+esc(v.detail||'')+'</div>';
    }
  }).catch(function(e){
    document.getElementById('audit-body').textContent='audit endpoint error: '+e.message;
  });

  fetch('/api/telemetry?days=7').then(function(r){return r.json()}).then(function(t){
    var b=document.getElementById('telemetry-body');
    b.className='';
    var rows=[];
    rows.push(['shards', (t.from||'—')+' → '+(t.to||'—')]);
    rows.push(['events', t.events]);
    rows.push(['goals (finished)', t.goals.count+' ('+(t.goals.completedRate*100).toFixed(0)+'% completed)']);
    rows.push(['goal duration p50', t.goals.durationMsP50!=null?t.goals.durationMsP50+' ms':'n/a']);
    rows.push(['model calls', t.models.callCount+' ('+t.models.tokenTotal+' tokens)']);
    rows.push(['verifications', t.verification.count+' ('+(t.verification.successRate*100).toFixed(0)+'% pass)']);
    var fc=Object.keys(t.failureClasses||{});
    rows.push(['failure classes', fc.length?fc.map(function(k){return k+'×'+t.failureClasses[k]}).join(', '):'none']);
    b.innerHTML=rows.map(function(r){return '<div class="kv"><span>'+esc(r[0])+'</span><span>'+esc(r[1])+'</span></div>'}).join('');
  }).catch(function(e){
    document.getElementById('telemetry-body').textContent='telemetry endpoint error: '+e.message;
  });

  function addEvent(e){
    var first=evBody.querySelector('.empty'); if(first) first.remove();
    var row=document.createElement('div'); row.className='row';
    var payload=Object.assign({},e); delete payload.type; delete payload.at;
    var p=JSON.stringify(payload); if(p.length>240)p=p.slice(0,240)+'…';
    row.innerHTML='<span class="t">'+esc((e.at||'').slice(11,19))+'</span>'+
      '<span class="k">'+esc(e.type)+'</span><span class="p">'+esc(p)+'</span>';
    evBody.insertBefore(row, evBody.firstChild);
    while(evBody.children.length>MAX_ROWS) evBody.removeChild(evBody.lastChild);
  }

  // ---- consent surface (only wired when the server says writes are on — WRITES
  // is server-rendered ground truth, never guessed client-side) ----
  var WRITES=${enableWrites ? 'true' : 'false'};
  if(WRITES){
    var cres=document.getElementById('c-result');
    function showResult(msg,isErr){cres.textContent=msg;cres.className=isErr?'err':'ok2'}
    document.getElementById('c-grant').addEventListener('click',function(){
      var scope=document.getElementById('c-scope').value.trim();
      var user=document.getElementById('c-user').value.trim();
      if(!scope){showResult('scope is required — grants are always exact',1);return}
      if(!user){showResult('operator name is required — no self-consent',1);return}
      var payload={scope:scope,user:user,mode:document.getElementById('c-mode').value,
        maxUses:Math.max(1,parseInt(document.getElementById('c-maxuses').value,10)||1),
        ttlMs:Math.max(0,parseInt(document.getElementById('c-ttl').value,10)||0)*1000};
      fetch('/api/consent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
        .then(function(r){return r.json().then(function(b){return{code:r.status,body:b}})})
        .then(function(x){
          if(x.code===201){showResult('granted '+x.body.granted+' (mode '+x.body.status.mode+', uses left '+x.body.status.usesLeft+') — mirrored to audit chain',0)}
          else{showResult('rejected '+x.code+': '+esc(x.body.error||'unknown'),1)}
        }).catch(function(e){showResult('network error: '+e.message,1)});
    });
    var revokeBtn=document.getElementById('c-revoke');
    var armed=false, armTimer=null;
    revokeBtn.addEventListener('click',function(){ // Irreversibility Gate: first click arms, second executes
      var scope=document.getElementById('c-status-scope').value.trim();
      if(!scope){showResult('enter the scope to revoke first',1);return}
      if(!armed){
        armed=true;revokeBtn.className='danger armed';revokeBtn.textContent='Click again to revoke "'+scope.slice(0,32)+'"';
        armTimer=setTimeout(function(){armed=false;revokeBtn.className='danger';revokeBtn.textContent='Revoke'},3500);
        return;
      }
      clearTimeout(armTimer);armed=false;revokeBtn.className='danger';revokeBtn.textContent='Revoke';
      fetch('/api/consent?scope='+encodeURIComponent(scope),{method:'DELETE'})
        .then(function(r){return r.json()})
        .then(function(b){showResult(b.existed?'revoked '+b.revoked:'revoked '+b.revoked+' (nothing was granted)',0)})
        .catch(function(e){showResult('network error: '+e.message,1)});
    });
    document.getElementById('c-status').addEventListener('click',function(){
      var scope=document.getElementById('c-status-scope').value.trim();
      if(!scope){document.getElementById('c-status-out').textContent='enter a scope';return}
      fetch('/api/consent/status?scope='+encodeURIComponent(scope))
        .then(function(r){return r.json()})
        .then(function(b){
          document.getElementById('c-status-out').textContent=b.granted
            ?('granted · mode '+b.mode+' · user '+b.user+' · uses left '+b.usesLeft+(b.expiresAt?' · expires '+new Date(b.expiresAt).toISOString():''))
            :(b.expired?'expired':'not granted');
        }).catch(function(e){document.getElementById('c-status-out').textContent='error: '+e.message});
    });
  }

  // ---- receipts panel: reads the chain of record via /api/receipts; a broken
  // chain is displayed as a warning, never as an empty "nothing happened" ----
  var rBody=document.getElementById('receipts-body');
  function loadReceipts(){
    var gid=document.getElementById('r-goal').value.trim();
    fetch('/api/receipts?limit=50'+(gid?'&goalId='+encodeURIComponent(gid):''))
      .then(function(r){return r.json()})
      .then(function(b){
        if(!b.ok){
          rBody.className='';
          rBody.innerHTML='<div style="color:var(--bad)">chain broken ('+esc(b.reason)+') — receipts withheld, not presented as fact</div>';
          return;
        }
        if(b.count===0){rBody.className='empty';rBody.textContent=gid?('no receipts for '+gid):'no receipts yet';return}
        rBody.className='';
        rBody.innerHTML=b.receipts.slice().reverse().map(function(r){
          return '<div class="rcpt"><span class="'+(r.verified?'v':'u')+'">'+(r.verified?'✓':'?')+'</span>'+
            '<span class="act">'+esc(r.action)+'</span>'+
            '<span class="gid">'+esc(r.goalId)+(r.taskId?'/'+esc(r.taskId):'')+'</span>'+
            '<span>'+esc(r.result)+'</span>'+
            '<span class="h">'+esc((r.hash||'').slice(0,12))+'…</span>'+
            '<span class="h">'+esc((r.at||'').slice(5,19))+'</span></div>';
        }).join('');
      }).catch(function(e){rBody.className='';rBody.textContent='receipts endpoint error: '+e.message});
  }
  document.getElementById('r-refresh').addEventListener('click',loadReceipts);
  loadReceipts();

  var VOICE=${enableVoice ? 'true' : 'false'};
  var BUNDLE=${enableBundle ? 'true' : 'false'};
  var DOCTOR=${enableDoctor ? 'true' : 'false'};
  if(DOCTOR){
    var dOut=document.getElementById('d-out');
    document.getElementById('d-run').addEventListener('click',function(){
      dOut.style.display='block';dOut.className='';dOut.textContent='probing…';
      fetch('/api/doctor/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
        .then(function(r){return r.json().then(function(b){return{code:r.status,body:b}})})
        .then(function(x){var b=x.body;
          if(x.code!==200){dOut.className='err';dOut.textContent='REFUSED '+x.code+': '+esc(b.error||'');return}
          var lines=['VERDICT: '+b.verdict+' (core-fail '+b.summary.coreFailed+' · gated-optional '+b.summary.gatedOpt+')',''];
          for(var i=0;i<b.checks.length;i++){var c=b.checks[i];lines.push((c.state+'             ').slice(0,15)+' ['+c.req+'] '+c.name+' — '+c.detail)}
          dOut.className=b.verdict==='NOT_READY'?'err':'ok2';dOut.textContent=lines.join('\\n');
        }).catch(function(e){dOut.className='err';dOut.textContent='doctor failed: '+e.message});
    });
  }
  if(BUNDLE){
    var bVerdict=document.getElementById('b-verdict');
    function bShow(cls,txt){bVerdict.style.display='block';bVerdict.className=cls;bVerdict.textContent=txt}
    document.getElementById('b-export').addEventListener('click',function(){
      bShow('','exporting dossier…');
      fetch('/api/bundle/export',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
        .then(function(r){return r.json().then(function(b){return{code:r.status,body:b}})})
        .then(function(x){var b=x.body;
          if(x.code===200){bShow('ok2','BUNDLE EXPORTED\\nfiles: '+b.files+' · entries: '+b.stats.entries+' · anchors: '+b.stats.anchors+' · tsr: '+b.stats.tsr+'\\ndestination: operator-fixed --bundle-dir')}
          else{bShow('err','EXPORT REFUSED '+x.code+': '+esc(b.cls||'')+' — '+esc(b.error||b.reason||''))}
        }).catch(function(e){bShow('err','export failed: '+e.message)});
    });
    document.getElementById('b-verify').addEventListener('click',function(){
      bShow('','verifying dossier…');
      fetch('/api/bundle/verify',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
        .then(function(r){return r.json().then(function(b){return{code:r.status,body:b}})})
        .then(function(x){var b=x.body;
          var lines=['verdict: '+b.cls];
          if(b.detail)lines.push(b.detail);
          if(b.cls==='BUNDLE_OK')lines.push('chain entries: '+b.chainEntries+' · anchors: '+b.anchors+' · tsr: '+b.tsr+(b.genTime?' · existence-in-time: '+b.genTime:''));
          bShow(b.cls==='BUNDLE_OK'?'ok2':'err',lines.join('\\n'));
        }).catch(function(e){bShow('err','verify failed: '+e.message)});
    });
  }
  if(VOICE){
    var vOut=document.getElementById('v-out'), vTr=document.getElementById('v-transcript');
    document.getElementById('v-speak').addEventListener('click',function(){
      var text=document.getElementById('v-text').value.trim();
      if(!text){vOut.className='err';vOut.textContent='text is required';return}
      vOut.className='';vOut.textContent='synthesizing…';
      fetch('/api/voice/speak',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:text})})
        .then(function(r){return r.json().then(function(b){return{code:r.status,body:b}})})
        .then(function(x){var b=x.body;
          if(x.code===200){
            vOut.className='ok2';
            vOut.innerHTML='evidence: '+b.bytes+' bytes · '+esc(b.format)+' · '+(b.verified?'sha256-verified ✓':'unverified')+' · provider '+esc(b.provider)+'<br><audio controls src="'+encodeURI(b.audio)+'"></audio>';
          } else if(x.code===403&&b.pendingScope){
            vOut.className='err';vOut.textContent='consent required: grant "'+b.pendingScope+'" in the Consent panel (external synthesis never runs silently)';
          } else if(x.code===503){
            vOut.className='err';vOut.textContent='dependency missing: '+esc(b.error||'');
          } else {vOut.className='err';vOut.textContent='rejected '+x.code+': '+esc(b.error||'unknown')}
        }).catch(function(e){vOut.className='err';vOut.textContent='network error: '+e.message});
    });
    document.getElementById('v-listen').addEventListener('click',function(){
      var f=document.getElementById('v-file').files[0];
      if(!f){vTr.className='err';vTr.textContent='choose a WAV file first';return}
      var rd=new FileReader();
      rd.onload=function(){
        var b64=btoa(String.fromCharCode.apply(null,new Uint8Array(rd.result)));
        vTr.className='';vTr.textContent='transcribing…';
        fetch('/api/voice/listen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wavBase64:b64})})
          .then(function(r){return r.json().then(function(b){return{code:r.status,body:b}})})
          .then(function(x){var b=x.body;
            if(x.code===200){
              vTr.className=b.verdict==='capture'?'ok2':'';
              vTr.textContent='verdict: '+b.verdict+' · provider '+esc(b.provider)+(b.verdict==='capture'?('\\ntranscript: '+esc(b.transcript)):'\\n(no speech captured — honest empty, nothing fabricated)');
            } else if(x.code===403&&b.pendingScope){
              vTr.className='err';vTr.textContent='consent required: grant "'+b.pendingScope+'" in the Consent panel';
            } else if(x.code===503){
              vTr.className='err';vTr.textContent='dependency missing (no whisper binary on this host): '+esc(b.error||'');
            } else {vTr.className='err';vTr.textContent='rejected '+x.code+': '+esc(b.error||'unknown')}
          }).catch(function(e){vTr.className='err';vTr.textContent='network error: '+e.message});
      };
      rd.readAsArrayBuffer(f);
    });
  }

  var GOALS=${enableGoals ? 'true' : 'false'};
  if(GOALS){
    var gOut=document.getElementById('g-out');
    document.getElementById('g-run').addEventListener('click',function(){
      var objective=document.getElementById('g-objective').value.trim();
      if(!objective){gOut.className='err';gOut.textContent='objective is required';return}
      gOut.className='';gOut.textContent='running… (telemetry + audit chain record everything)';
      fetch('/api/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({objective:objective})})
        .then(function(r){return r.json().then(function(b){return{code:r.status,body:b}})})
        .then(function(x){
          var b=x.body;
          if(x.code===200){
            gOut.className=(b.state==='COMPLETED'||b.state==='DONE'||b.state===0)?'ok2':'';
            gOut.textContent='state: '+b.state+(b.produced&&b.produced.length?'\\nproduced: '+b.produced.join(', '):'')+(b.error?'\\nerror: '+b.error:'')+'\\nworkspace: '+b.workspaceFixed+(b.workspaceOverrideIgnored?' (body workspace ignored by construction)':'');
          } else if(x.code===403&&b.requiredScope){
            gOut.className='err';
            gOut.textContent='consent required: grant scope "'+b.requiredScope+'" in the Consent panel above (named human, mode "once" = approve this one run). Note: '+esc(b.note||'');
          } else if(x.code===409){
            gOut.className='err';gOut.textContent='busy: '+(b.current?b.current.objective:'another run')+' — one operator-run at a time';
          } else {
            gOut.className='err';gOut.textContent='rejected '+x.code+': '+esc(b.error||b.detail||'unknown');
          }
        }).catch(function(e){gOut.className='err';gOut.textContent='network error: '+e.message});
    });
  }

  var es=new EventSource('/api/events');
  es.addEventListener('message',function(m){
    try{
      var e=JSON.parse(m.data);
      if(e.type==='goal.receipt'||e.type==='goal.receipt_verified') loadReceipts(); // live refresh on the receipt events
    }catch(_){ }
  });
  es.onopen=function(){conn.textContent='live';conn.className='live'};
  es.onerror=function(){conn.textContent='disconnected (retrying)';conn.className=''};
  es.onmessage=function(m){
    try{ addEvent(JSON.parse(m.data)); }catch(_){/* heartbeat comments are not messages */}
  };
})();
</script>
</body>
</html>`;
}
