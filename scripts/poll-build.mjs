import { execSync } from 'node:child_process';
const PAT = await import('node:fs').then(m=>m.default.readFileSync('/home/user/.secrets/github.pat','utf8').trim());
const runId = process.argv[2];
const j = await (await fetch(`https://api.github.com/repos/rssen-debug/MAJINCLI/actions/runs/${runId}/jobs`, { headers: { Authorization: 'Bearer '+PAT } })).json();
for (const job of j.jobs||[]) {
  console.log(job.name, '→', job.status, job.conclusion || '', '('+ (job.steps?.filter(s=>s.conclusion==='success').length||0) + '/' + (job.steps?.length||0) + ' steps)');
  const fail = (job.steps||[]).find(s=>s.conclusion==='failure');
  if (fail) console.log('  FAILED:', fail.name);
}
