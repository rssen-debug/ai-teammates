# Testa att Buddy verkligen är live på din egen dator

Den här guiden ger **bevis**, inte påståenden. Varje steg nedan körs mot riktig
maskinvara och rapporterar `pass`, `fail`, `blocked` eller `skipped`.

> **BLOCKED ≠ FEL.** BLOCKED betyder att något i operativsystemet saknas
> (behörighet, desktop-session, nyckel). Ett grönt steg betyder alltid att ett
> riktigt verktygssvar har observerats — aldrig att modellen bara sa det.

---

## 0. Installera rätt version

Fixarna i den här guiden ligger i PR #6. Den senaste releasen (`cli-v0.2.214`)
är äldre och saknar dem. Bygg därför från branchen:

```bash
git clone https://github.com/rssen-debug/ai-teammates.git
cd ai-teammates/studdy-buddy
git checkout arena/428b0133-ai-teammates
npm ci
npm run package:cli
npm install -g ./dist/studdy-buddy-0.2.0.tgz
studdy --version
```

Kräver **Node >= 22.13**. När PR #6 är mergad publiceras en ny release och du kan
installera tarballen därifrån i stället.

---

## 1. Grundkontroll (30 sekunder)

```bash
studdy setup
studdy doctor
```

`setup` beviljar appens egna scopes en gång. `doctor` visar Node, databas,
native helper, AI-nyckel och behörighet var för sig.

**Förväntat på Windows:** `Native helper` grön. Om den är BLOCKED har du ingen
desktop-session eller så nekas accessibility — då kan inget i steg 2 fungera.

---

## 2. Live-beviset — ett kommando

```bash
studdy prove
```

Detta är det viktigaste kommandot. Det kör hela kedjan mot din riktiga dator:

| Steg | Vad som faktiskt verifieras |
| --- | --- |
| Native helper | `agent-desktop` svarar och OS-behörighet är beviljad |
| Behörighet | `computer.actions` är beviljad lokalt |
| Appstart | En scratch-app (Notepad/TextEdit/gedit) startas på riktigt |
| Fönsterobservation | Fönstret **hittas i den riktiga fönsterlistan** — ett lyckat startanrop räcker inte |
| UI-träd | Tillgänglighetsträdet läses och innehåller element |
| Skrivtest | En slumpad markör skrivs i fältet **och läses tillbaka** ur UI-trädet |
| Skärmbild | En PNG skrivs till disk och verifieras ha innehåll (raderas direkt) |

Skrivtestet sker **bara i scratch-appen som kommandot självt startade**, aldrig
i dina dokument. Vill du hoppa över det: `studdy prove --no-write`.

Annan app: `studdy prove --app "Google Chrome"`.

Exitkod är `0` endast när alla steg är `pass` (eller medvetet `skipped`).
Maskinläsbart: `studdy prove --json`.

Notepad-fönstret med testtexten lämnas kvar — stäng det själv.

---

## 3. Att AI:n verkligen svarar

```bash
studdy            # interaktiv; /setup frågar efter nyckel med dold inmatning
```

Eller utan att nyckeln hamnar i shell-historiken (PowerShell):

```powershell
$key = Read-Host "Kilo-nyckel"
$key | studdy provider set kilo --key-stdin
studdy provider test
studdy provider probe
studdy ask "förklara subnetting som om jag vore nybörjare"
```

- `provider test` = ett riktigt HTTP-anrop mot din provider.
- `provider probe` = mäter text, streaming, JSON, vision och tool-calls var för sig.
- Vision kräver ett uttryckligt modell-id:
  `studdy provider set kilo --key-stdin --vision-model "<vision-modell-id>"`.

Fungerar inte `provider test` är det nätverk, nyckel eller modell-id — inte något
i datorstyrningen.

---

## 4. Se live-statusen växla

```bash
studdy watch
```

Låt det stå och växla mellan ett vanligt program (t.ex. Anteckningar) och något
annat. Status blir grön **först efter** en lyckad läsning av ett tillåtet fönster,
och faller tillbaka efter 35 sekunder utan ny observation.

Privata fönster (bank, inloggning, lösenordshanterare, incognito, chattar) pausar
observationen medvetet. Det är inte ett fel.

Engångsmätning för skript: `studdy watch --once` (exitkod 1 om ingen live-observation).

Fråga agenten rakt ut:

```bash
studdy ask "är du live just nu?"
studdy ask "vad ser du på min skärm?"
```

Svarar den att den inte ser något är det det ärliga svaret — inte en bugg.

---

## 5. Webbläsartillägget

```bash
studdy sites allow canvas.instructure.com
studdy bridge
```

Kommandot skriver ut en token. I Chrome: `chrome://extensions` → Developer mode
→ Load unpacked → välj `apps/browser-extension`. Klistra in token i popupen och
aktivera läsning. Öppna den tillåtna sajten.

Kontrollera från en **annan** terminal att bryggan faktiskt lever:

```bash
studdy sites
studdy progress
```

`sites` visar `bridge.running: true` först efter en autentiserad anslutning.

---

## 6. Minne och nivå

```bash
studdy memory
studdy progress
```

`memory` skriver en Obsidian-vault och returnerar sökvägen. Öppna mappen — där
finns riktiga Markdown-filer. `progress` visar nivå baserad på **unika verifierade
verktygsfall**. Upprepa samma launch höjer inte nivån; ett nytt slags bevis gör det.

---

## 7. Om något är BLOCKED

| Symptom | Orsak | Åtgärd |
| --- | --- | --- |
| `Native helper` BLOCKED på Linux | Ingen grafisk session / D-Bus / AT-SPI | Kör i en riktig desktop-session, inte headless |
| `Native helper` BLOCKED på macOS | Accessibility-behörighet saknas | Systeminställningar → Integritet & säkerhet → Tillgänglighet |
| `UI-träd` BLOCKED | Appen exponerar inget tillgänglighetsträd | Testa med Anteckningar/TextEdit först |
| `Skärmbild` BLOCKED | Skärminspelningsbehörighet nekad | Bevilja i OS-inställningar |
| `Skrivtest` fail | Text skickades men kunde inte läsas tillbaka | Rapportera som fel — det är inte bevisat |
| `provider test` fel | Nätverk, nyckel eller modell-id | Kontrollera nyckel och `--base-url`/`--model` |

Skicka med detta när du rapporterar fel:

```bash
studdy doctor --json
studdy prove --json
studdy logs
```

Loggen är rensad från nycklar, skärmbilder och chattinnehåll.

---

## Vad som redan är bevisat i CI

Windows-CI kör `studdy prove --app "Notepad"` mot en riktig Windows-desktop och
failar om något steg inte lyckas. Linux-CI kör den byggda CLI:n i riktiga
processer mot lokal HTTP, WebSocket och PTY, och kontrollerar uttryckligen att
en headless miljö rapporteras som BLOCKED — aldrig som grön.

Live-anrop mot Kilo, Gmail och GitHub är **inte** verifierade i sandboxen
(egress blockerad). De testas lokalt med syntetisk transport och blir verkligt
bevisade först när du kör steg 3 och 5 på din egen dator.
