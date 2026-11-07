/** Minimal, dependency-free MAJIN V3 surface for the verified file-task slice. */
export function renderV3Page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>MAJIN V3</title>
<style>
:root{color-scheme:dark;--bg:#09090d;--surface:#111117;--ink:#f5f2f8;--muted:#aaa5b4;--pink:#f18bd7;--violet:#a98aff;--line:#292532;--focus:#f8b5e7}
*{box-sizing:border-box}body{min-height:100vh;margin:0;background:radial-gradient(ellipse at 50% 24%,#211329 0,transparent 38%),var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.shell{width:min(720px,100% - 32px);margin:0 auto;padding:28px 0 48px}.top{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:13px;letter-spacing:.04em}.brand{color:var(--ink);font-size:15px;font-weight:650;letter-spacing:.16em}.dot{width:8px;height:8px;border-radius:50%;background:var(--pink);box-shadow:0 0 18px #ef83da88}
main{padding-top:clamp(52px,11vh,104px)}.presence{display:flex;justify-content:center;margin-bottom:28px}.orb{width:66px;height:66px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#f6c6ee 0 5%,#ec86da 24%,#a578ec 62%,#33214f 100%);box-shadow:0 0 32px #c274df33, inset -8px -10px 20px #26123a66}
h1{margin:0;text-align:center;font-size:clamp(28px,5vw,38px);line-height:1.18;letter-spacing:-.035em;font-weight:600}.intro{max-width:510px;margin:12px auto 30px;text-align:center;color:var(--muted)}
form{padding:22px;background:color-mix(in srgb,var(--surface) 94%,transparent);border:1px solid var(--line);border-radius:22px;box-shadow:0 16px 50px #0003}.field{display:grid;gap:7px;margin-bottom:16px}label{color:#ded9e5;font-size:13px;font-weight:550}input,textarea{width:100%;border:1px solid #393342;border-radius:12px;background:#0b0a10;color:var(--ink);padding:12px 14px;font:inherit;font-size:15px;outline:none}textarea{min-height:128px;resize:vertical}input:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.hint{margin:-2px 0 14px;color:var(--muted);font-size:12px}
.actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.truth{color:var(--muted);font-size:12px}.submit{border:0;border-radius:999px;padding:11px 18px;background:linear-gradient(110deg,var(--pink),var(--violet));color:#17101c;font:inherit;font-size:14px;font-weight:700;cursor:pointer}.submit:disabled{opacity:.62;cursor:wait}
.result{margin-top:18px;padding:13px 15px;border:1px solid var(--line);border-radius:14px;color:var(--muted);font-size:14px;overflow-wrap:anywhere}.result[hidden]{display:none}.result[data-state="success"]{border-color:#49745f;color:#d7f5e3}.result[data-state="error"]{border-color:#71464b;color:#ffdfe1}.result strong{color:var(--ink)}.result code{font-size:12px;color:#e5b7e0}
footer{margin-top:20px;text-align:center;color:#858090;font-size:12px}
@media(max-width:520px){.shell{width:min(100% - 24px,720px);padding-top:20px}main{padding-top:50px}form{padding:17px;border-radius:18px}.actions{align-items:flex-start;flex-direction:column}.submit{width:100%}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="shell">
<header class="top"><span class="dot" aria-hidden="true"></span><span class="brand">MAJIN</span><span>V3 local preview</span></header>
<main>
<div class="presence"><span class="orb" aria-hidden="true"></span></div>
<h1>Make something real.</h1>
<p class="intro">A small, honest first slice: describe the goal, provide one file, and MAJIN will create it in the selected local workspace and verify its contents.</p>
<form id="task-form">
<div class="field"><label for="objective">What are we making?</label><input id="objective" name="objective" maxlength="2000" required placeholder="Create a short welcome note for my project"></div>
<div class="field"><label for="fileName">File name</label><input id="fileName" name="fileName" maxlength="160" required placeholder="welcome.md"></div>
<div class="field"><label for="content">File content</label><textarea id="content" name="content" maxlength="1000000" required placeholder="Write the content to save…"></textarea></div>
<p class="hint">This preview writes one new file only. Existing files are never overwritten. No model, shell or network tool is used.</p>
<div class="actions"><span class="truth">Local deterministic demo · verified SHA-256</span><button class="submit" id="submit" type="submit">Create and verify</button></div>
</form>
<section id="result" class="result" role="status" aria-live="polite" hidden></section>
</main>
<footer>V3 foundation · complexity stays behind the conversation</footer>
</div>
<script>
const form=document.querySelector('#task-form');
const button=document.querySelector('#submit');
const result=document.querySelector('#result');
form.addEventListener('submit',async(event)=>{
  event.preventDefault();
  button.disabled=true;
  result.hidden=false;
  result.dataset.state='';
  result.textContent='Working…';
  const payload=Object.fromEntries(new FormData(form).entries());
  try{
    const response=await fetch('/api/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    const data=await response.json();
    result.replaceChildren();
    const title=document.createElement('strong');
    title.textContent=data.ok?'Verified':'Not completed';
    result.append(title,document.createTextNode(data.ok?' · '+data.artifact.name+' was created. ':' · '+(data.error?.message||'The task did not complete.')+' '));
    if(data.ok&&data.evidence?.sha256){const hash=document.createElement('code');hash.textContent='SHA-256 '+data.evidence.sha256;result.append(hash);}
    result.dataset.state=data.ok?'success':'error';
  }catch{
    result.dataset.state='error';
    result.textContent='The local MAJIN service could not be reached. No success was recorded.';
  }finally{button.disabled=false;}
});
</script>
</body>
</html>`;
}
