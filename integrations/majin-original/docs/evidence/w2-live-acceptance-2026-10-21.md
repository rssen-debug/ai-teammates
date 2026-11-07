
## W2 live-acceptance — REAL egress som bevisar pipelinen (runda 37, 2026-10-21)

W2 var **VERIFIED-CORE + ENV-BLOCK**: motorn är fixture-verifierad men real-net-integration saknade bevis eftersom sandbox-egress blockar DuckDuckGo/Bing. Runda 37 stängde luckan med en ärlig adapter: **api.github.com + GitHub-repo-sök är nåbart genom egress** → live-run med 0 fixtures.

### Vad som exekverades LIVE

`node scripts/research-live-acceptance.mjs "commander yargs cac clipanion typescript cli argument parsing" --save`

- **searchFn** = riktiga HTTPS-anrop till `api.github.com/search/repositories` (opencode/GitHub-token valfri, läses ur miljö, lagras aldrig).
- **fetchFn** = GitHub README-API (`/repos/{owner}/{repo}/readme`, base64→utf8).
- **Resultat LIVE:** 4 källor hämtade över nätverk (`lukeed/sade`, `mdbetancourt/soly`, `th317erd/simple-yargs`, `TheBrenny/big-kahuna` — riktiga arg-parsnings-libs), 21 clusters, 22 findings, `unsupported=0`, 18 konfliktflaggade (motorn kors-kontrollerar ställd mix av källor ärligt), verify-verdict "all claims sourced".
- **Tunn-terminen högljudd:** run med <3 källor eller unsupported claims → exit≠1, "refusing to count it".

### Lärdomar inbyggda i beviset (adapter-transparens)
1. GitHub repo-search AND:ar tokens → naturliga frågor ger 0 träffar; adaptern kör **deklarerad query-ladder** med `adapter-notes.json` som ledger-bevis vid varje steg (aldrig tyst fallbacks).
2. Klassisk IR-fälla: "which"-frågor styrde källsamplet till which-verktyg (thefuck, node-which, pyenv-which-ext) — blåögd ärlig miss; fixad via interrogativ-stopwords. Läxan finns i skriptet: fråga semantiken avgör källkvaliteten, adaptern äger bara utpräglat loggade transformationer.

### Evidence-artifacts (committade, off-line-auditerade)
`docs/evidence/research-live-2026-10-21/{report.md, ledger.json, sources.jsonl, adapter-notes.json}` + `test/research-live-acceptance.test.js` (5/5): evidential audit — verifierar kompottade receipts: riktiga GitHub-URLs med fetches-tidsstämplar samma timer, findings≥3, unsupported=0, adapter-notes högljudda, cross-check-clusters existerar. **Regression 859→864/0/17.**

### Kvarvarande ENV-BLOCK (oförändrad ärlighet)
DuckDuckGo/Bing-lanen förblir oprovade i sandlådan; verifieringen måste göras i acceptansmiljö med full egress. W2 står nu: VERIFIED-CORE + **LIVE-ACCEPTANCE (github-lane)** · ENV-BLOCK (ddg/bing).
