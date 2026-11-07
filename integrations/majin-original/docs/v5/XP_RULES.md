# MAJIN V5 — XP-regler och Nivå 1–99 (`majin.v5.xp-curve/v1`)

**Schema:** `majin.v5.xp-curve/v1`  
**Inspiration:** RuneScape 1–99 progression kombinerad med verifierade agentkvitton.

---

## 1. Grundprinciper

1. **Nivå 1 som start:** Varje skill börjar som otränad på **Nivå 1 (`0 XP`, status `UNTRAINED`)**. Befintlig kod i repot ger aldrig automatiskt hög nivå.
2. **Import med proveniens:** Tidigare verifieringsbevis (t.ex. från V4:s `learned-skills`) kan importeras med explicit proveniens (`origin: 'imported-v4'`, ursprungligt `receiptId` och SHA-256-bevis).
3. **Endast verifierad framgång ger XP:** XP utdelas uteslutande när ett mål slutförs med ett oberoende verifierat resultatkvitto (`file`, `http`, `dom`, `pixel` eller `script_artifact`).
4. **Vad som ALDRIG ger XP (`0 XP`):**
   - Antal modellanrop (`modelCalls`)
   - Förfluten tid (`elapsedMs`)
   - Att skriva eller redigera en `SKILL.md` / `skill.json`-fil utan verifierad uppgiftsframgång
   - Overifierade påståenden eller chatt-persistenskvitton (`kind: 'persistence'`, `chat.reply`)
   - Duplicerade kvitton (`receiptId` har redan belönats i `xp-ledger.jsonl`)
   - Upprepade triviala uppgifter för att farma poäng (`FARMING_GUARD`)

---

## 2. Den versionsbestämda XP-kurvan (`majin.v5.xp-curve/v1`)

För varje nivå $L \in \{1, \dots, 99\}$ definieras stegkostnaden $\Delta(L)$ och tröskeln $\text{XP}(L)$:

$$\Delta(L) = \left\lfloor 10 + 1.8 \cdot L^{1.55} + 12 \cdot 2^{L / 14} \right\rfloor$$

$$\text{XP}(1) = 0, \qquad \text{XP}(L) = \sum_{\ell=1}^{L-1} \Delta(\ell)$$

| Nivå | Krävd total XP | Betydelse |
|---|---|---|
| **1** | `0 XP` | Otränad startnivå (`UNTRAINED`) |
| **2** | `24 XP` | Första verifierade standarduppgiften (`+24 XP`) |
| **5** | `109 XP` | Grundläggande verifierad vana |
| **10** | `303 XP` | Tiotal verifierade uppgifter med variation |
| **18** | `767 XP` | Exempel: `Formulär 18/99 · +24 XP` |
| **25** | `1 407 XP` | Etablerad tillförlitlig skill |
| **50** | `6 600 XP` | Avancerad domänbehärskning |
| **75** | `22 866 XP` | Hög mognad över breda scenarier |
| **98** | `69 175 XP` | Maxnivå före kvalitetsgrind för nivå 99 |
| **99** | `73 599 XP` + **5 Kvalitetsgrindar** | Fullt verifierad version (`MASTERED`) |

---

## 3. Viktning, Variation och Begränsad XP-budget per uppgift

Varje verifierad uppgift har en begränsad XP-budget (`MAX_TASK_XP_BUDGET = 60`):

$$\text{TaskXP} = \min\left(60,\; \text{round}\left(\text{BaseXP} \times M_{\text{svårighet}} \times M_{\text{självständighet}} \times M_{\text{variation}}\right)\right)$$

- **Bas-XP (`BaseXP`):** `24 XP` för en normal verifierad uppgift.
- **Svårighetsgrad ($M_{\text{svårighet}} \in [0.5, 2.0]$):**
  - Trivial (`difficulty: 'trivial'`): `0.5`
  - Standard (`difficulty: 'standard'`): `1.0`
  - Krävande/flersteg (`difficulty: 'complex'`): `1.5`
  - Avancerad/workflow (`difficulty: 'advanced'`): `2.0`
- **Självständighet ($M_{\text{självständighet}} \in [0.6, 1.0]$):**
  - Självständig körning utan manuell korrigering: `1.0`
  - Med användarassistans/omstyrning: `0.75`
- **Variationsfaktor / Anti-farming ($M_{\text{variation}}$):**
  Räknas per unik uppgiftssignatur (`taskSignature`):
  - 1:a verifierade körningen av signaturen: `1.00`
  - 2:a identiska signaturen: `0.50`
  - 3:e identiska signaturen: `0.25`
  - 4:e och senare identiska repetitioner: `0.00` (`FARMING_BLOCKED` — 0 XP!)
- **Fördelning mellan Primär Skill och Stödskills:**
  - Om uppgiften endast använder en primär skill får den **100 %** av `TaskXP`.
  - Om uppgiften använder en primär skill + $k$ stödskills får primär skill **75 %** av `TaskXP` och stödskills delar på **25 %** ($\lfloor 0.25 \cdot \text{TaskXP} / k \rfloor$ var). Många delsteg kan därmed aldrig blåsa upp total XP.

---

## 4. Separata Mätvärden och STALE-hantering

För varje skill redovisas fyra separata dimensioner:
1. **Historisk nivå och XP:** `level` (1–99) och `xp` (förloras aldrig vid miljöbyte).
2. **Aktuell tillförlitlighet (`reliability`):** Andel verifierade framgångar över de senaste körningarna ($0.00\text{–}1.00$).
3. **Färskhet och kompatibilitet (`freshness`):** `FRESH`, `STALE` (när OS/Node/lanes/verktyg eller extern webbplats ändrats) eller `INCOMPATIBLE`.
4. **Senaste verifierade framgång:** `lastVerifiedAt` (ISO-tid) och `lastReceiptId`.

När miljön eller en målwebbplats ändras behåller skillen sin historiska nivå och XP, men markeras `STALE` tills en ny verifierad körning bekräftar kompatibilitet.

---

## 5. Kvalitetsgrindar för Nivå 99

Tillräcklig XP (`xp >= 73 599`) räcker **inte** för nivå 99. En skill stannar på nivå 98 tills samtliga fem krav är uppfyllda:
1. **Versionsbestämd testsvit:** `versionedTestSuitePassed === true` för exakt aktuell `skill.version`.
2. **Varierade uppgifter:** Minst `5` distinkta verifierade uppgiftsscenarier (`distinctScenariosCount >= 5`).
3. **Fel- och återhämtningsfall:** Minst `2` verifierade återhämtningar från fel (`verifiedRecoveryCount >= 2`).
4. **Färska verifieringsbevis:** `freshness === 'FRESH'` och `reliability >= 0.90`.
5. **Tydlig avgränsning:** Dokumenterat `masteryScope` med både `mastered` (vad som behärskas) och `limitations` (vad som ligger utanför).

**Betydelse av ”100 %”:** ”100 %” avser uteslutande att de definierade kraven för den specifika skillversionen är uppfyllda. Det presenteras aldrig som en garanti för att agenten klarar alla framtida uppgifter.
