# FEM5 — MAJIN v1.0.2: slutför och publicera

**Uppdrag till Arena AI:** Du har tillgång till agentens terminal, GitHub och användarens redan installerade Windows self-hosted runner. Utför arbetet självständigt från början till slut. Be inte användaren skriva "kör" flera gånger. Detta är ett exekveringsuppdrag, inte en plan eller statusrapport.

## Projekt och aktuell verifierad utgångspunkt
- Repo: `rssen-debug/MAJINCLI`
- PR: https://github.com/rssen-debug/MAJINCLI/pull/213
- Releasegren: `release/majin-v1.0.2-interactive-20261021`
- Senast observerad PR-head: `18839278a375b4436379665e9deacea61c172bfa`
- Senast observerad main: `29193b533c8934cab41d326db455ff8894fc7316`
- PR var **open / mergeable=false** och saknade Actions-runs på senaste head vid kontroll. Kontrollera om detta ändrats innan arbete.
- Tidigare verkligt free-model-test: case 01 och 04 PASS; case 05 BLOCKED/FAIL med genererad JavaScript-syntax (bl.a. bokstavliga `\\n`), `turn_timeout` och uteblivna sandbox CLI-körningar. Historiskt workflow: https://github.com/rssen-debug/MAJINCLI/actions/runs/39589883637
- Senaste ändringen i `src/core/goal-artifact.js` inspekterar sparad fil vid syntaxfel; **inte verifierad** med fullständig regression.
- Den lokala Windows-runnern är enligt användaren **redan installerad och tidigare använd**. Installera inte om utan konkret anledning.
- OpenCode **Go** (molnleverantör), inte OpenCode Zen. Lokal Qwen är inte produktens standard; Qwen-testet får köras på GitHub Actions-hostad runner.

## PRIORITET 0 — Pusha Arenas redan färdiga merge-lösning NU

Arena har i sin egen session sagt att merge-resolution redan finns lokalt och erbjudit att pusha den till `fix/v102-merge-resolution`. **Detta är första obligatoriska handlingen, inte en fråga till användaren.**

1. Leta upp den befintliga lokala worktree/branchen/committen med merge-resolution i Arenas arbetsmiljö. Kontrollera `git status`, `git worktree list`, `git branch -avv`, `git log` och `git diff`. Förlora inte opushade ändringar.
2. Om ändringarna är okommittade: kontrollera konfliktmarkörer, kör relevanta syntax-/unit-tester, stagea **endast avsedda filer** och committa. Om de redan är committade, återanvänd committen. Använd aldrig `git push --force` för att skriva över andras arbete.
3. Pusha lösningen till remote-grenen `fix/v102-merge-resolution` (`git push -u origin HEAD:refs/heads/fix/v102-merge-resolution`, efter att du verifierat att du är på rätt commit och att remote inte har nyare ändringar). Om branchen redan finns: fetch och integrera först.
4. Kontrollera med `git ls-remote --heads origin fix/v102-merge-resolution` och via GitHub att pushen verkligen syns. Spara commit-SHA och länk.
5. Öppna en PR mot **rätt målgren** eller integrera den granskade resolutionen i PR #213:s releasegren utan att skriva över andra agenters ändringar. Kontrollera att PR #213 blir mergebar.
6. **Fortsätt sedan direkt med alla steg nedan**: case 05, alla CI-gates, Windows-runner, OpenCode Go, installer, merge, release och SHA256. Stanna inte efter push, fråga inte användaren att välja alternativ 1/2/3.

Om den påstått färdiga lokala resolutionen inte längre finns: säg det i loggen, gör en ny korrekt trevägsmerge från aktuell remote och pusha den. Markera inte detta som färdigt förrän remote-grenen finns och koden är verifierad.

## Obligatoriskt arbetsflöde

### 1. Inventera och säkra arbetet
- Hämta senaste `main`, PR #213, Actions-status, branch protection och relevanta workflow-filer.
- Kontrollera working tree och eventuell samtidig agentaktivitet; bevara lokala ändringar. Arbeta i separat worktree/branch vid behov. Force-pusha aldrig `main` eller releasegrenen.
- Läs `ARENA.md`, release-evidence och kod/tester. Identifiera vilka gates som är obligatoriska.
- Kontrollera GitHub self-hosted runner-status och labels utan att exponera hemligheter. Använd befintlig runner.

### 2. Lös mergekonflikterna på riktigt
- Utför riktig trevägsmerge mot `origin/main` med gemensam merge-bas; lista alla konfliktfiler.
- Jämför BASE/OURS/THEIRS per konflikt och sammanfoga semantiskt. **Behåll funktionalitet från båda sidor**. Ingen generell `--ours` eller `--theirs`, ingen blind overwrite.
- Kontrollera särskilt `src/core/goal-artifact.js`, workflow-filer, `CHANGELOG.md`, installer/release-filer, `package-lock.json` och andra konflikter som Git faktiskt rapporterar.
- Tidigare inspektion visade identiska blobbar på båda brancherna för `src/core/computer-use.js`, `src/core/tools/computer.js`, `src/core/tools/wincontrol.js`, `package.json` — verifiera på nytt.
- Kör syntaxkontroller, lockfile-validering, relevanta enhetstester; committa merge till PR-grenen och kontrollera att PR blir mergebar. Hantera nya main-commits utan att förlora kod.

### 3. Reparera free-model regression case 05
- Kör den **riktiga** regressionen, inte mock. Återskapa JavaScript-syntaxfelet och timeout med artefakter/loggar.
- Inspektera prompt, tool-output, feedback-loop, write-retry, `node --check`, sandbox-körning, timeout och eventuella loopar.
- Reparera grundorsaken i agenten. En lyckad `fs.write` betyder inte att uppgiften är klar; verifiera faktisk fil, giltig JS, exports och två riktiga CLI-anrop i sandbox när testet kräver det.
- Begränsa reparationsloopar utan att dölja fel. Lägg regressionstester som fångar bokstavliga escaped newlines och återkommande syntaxfel.
- Kör om **case 01, 04 och 05**, därefter full battery 01–11 om workflow stöder den. Rapportera exakta PASS/FAIL/BLOCKED, inte påstådda resultat.

### 4. Fullständig verifiering på rätt miljö
- Kör samtliga obligatoriska offline-contract/unit/integration/CI-gates på **slutlig commit**.
- Kör riktig **OpenCode Go**-acceptance med tillgänglig autentisering och verifiera modellista, val av free-modeller, kvarstående valt provider/modell efter omstart, prompt→verktyg→resultat och felhantering. Be aldrig om att användaren skickar API-nycklar i chatten.
- Kör Windows GUI/UX på **befintlig self-hosted runner**: första start, navigering, inställningspersistens, chatt/skicka-knapp, modellväljare, loading/progress, fel/återhämtning och tillgänglighet. Samla skärmbilder/loggar.
- Kör verklig computer-use i säker testmiljö: mus, tangentbord, screenshots, browser/desktop automation, permissions, timeout/retry och stop-knapp.
- Bygg Windows EXE/installer, installera i ren testmiljö, starta, stäng, återstarta, testa uppdateringsflöde om tillämpligt och avinstallera. Verifiera signering om krav finns; hitta inte på att binären är signerad.
- Om ett jobb inte startar: undersök `on:`-filter, branch protection, runner labels, permissions, secrets, concurrency, workflow syntax och runner online-status. Fixa orsaken och trigga om. Markera inte NOT TESTED som PASS.

### 5. Merge och publicera först efter gröna gates
- Kontrollera att **samtliga obligatoriska gates är gröna på exakt den commit som ska mergas** och att PR #213 är mergebar.
- Merga till `main` utan att tappa kod. Verifiera ny main-SHA.
- Bygg/publicera GitHub Release **v1.0.2** från rätt commit enligt projektets releaseprocess. Skapa inte en konkurrerande eller felaktig release om taggen redan finns; verifiera befintliga artefakter.
- Hämta publicerad Windows-installationsfil och beräkna `SHA256` på faktiska nedladdade bytes. Jämför mot build-artifact och dokumentera.
- Verifiera release-URL och att installationsfilen är åtkomlig.

## Hårda regler
- Ingen test-bypass, inga fake-PASS, inga dolda failures, inga sänkta säkerhetskrav för att få grönt.
- Ingen force-push till skyddade grenar, inga förstörda lokala ändringar, inga hemligheter i loggar/commits.
- Om verklig extern spärr finns (saknad autentisering, runner offline, GitHub-behörighet): ge **exakt** åtgärd som krävs av användaren, men fortsätt allt annat som går.
- Ingen ny feature-scope förrän release-gates är gröna. Arbeta i långa sammanhängande pass; sluta inte efter en liten fix.

## Slutrapport (obligatorisk)
1. Releaseversion och exakt main/release-commit.
2. PR- och release-länkar.
3. Tabell med varje obligatorisk gate, miljö, commit, PASS/FAIL/BLOCKED och bevislänk.
4. Antal godkända/misslyckade/ej körda tester.
5. Verifierade funktioner (OpenCode Go, Windows UI, computer-use, installer).
6. Återstående begränsningar.
7. Direktlänk till Windows-installationsfilen.
8. SHA256 för exakt publicerad installationsfil.

**Säg endast `RELEASE READY` när allt ovan är uppfyllt och bevisat.**
