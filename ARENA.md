# MAJIN v1.0.2 — Release checklist

Repo: `rssen-debug/MAJINCLI`. PR: #213.

Arena AI: slutför detta autonomt utan att be användaren skriva "kör" mellan stegen.

1. Lös mergekonflikterna mellan PR #213 och `main`; bevara båda sidors ändringar.
2. Fixa real free-model regression case 05: ogiltig genererad JavaScript (bokstavliga `\\n`) och timeout. Åtgärda grundorsaken; manipulera inte testresultat.
3. Kör alla obligatoriska CI-gates tills gröna. Verifiera OpenCode Go live, sparat modellval, agentverktyg, Windows UI/UX, computer-use och installer på riktig Windows-miljö.
4. Merga först när PR är mergebar och samtliga obligatoriska gates godkända. Bygg och publicera v1.0.2.
5. Verifiera publicerad EXE mot release-asset och SHA256. Rapportera commit, tester PASS/FAIL/BLOCKED, begränsningar, release-URL och checksumma.

**Regel:** Säg inte RELEASE READY förrän allt är verifierat. Ingen lokal Qwen på användarens CPU; använd GitHub CI för fri modell och OpenCode Go i molnet.
