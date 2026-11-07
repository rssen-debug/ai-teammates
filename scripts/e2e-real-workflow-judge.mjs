#!/usr/bin/env node
/* Real-workflow lifecycle judge: långsamma CPU är inte ett misslyckande.
   Bedömer om den levande server uppgiften faktiskt gjort framsteg eller lär göra det. */
import fs from 'node:fs';
const token = JSON.parse(fs.readFileSync('/home/user/.majin/config.json','utf8')).server.token;
const port = process.argv[2] || 19877;
const ts = await (await fetch(`http://127.0.0.1:${port}/api/tasks?t=${token}`, { headers:{Authorization:'Bearer '+token}})).json();
const latest = (ts.tasks||[])[0];
console.log(JSON.stringify({
  latestTask: latest ? { id: latest.id, status: latest.status, last: latest.last, toolsRun: latest.toolsRun, created: latest.created, updated: latest.updated } : null,
  serverAgeMin: latest ? Math.round((Date.now()-latest.created)/60000*10)/10 : 0,
  filesInWorkspace: fs.readdirSync('/home/user/.majin/workspace'),
}, null, 1));
