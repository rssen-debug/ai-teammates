# Röst och autopilot — vad som är byggt, och vad som är bevisat

Det här dokumentet finns för att svaret på "fungerar rösten?" aldrig ska vara en
gissning. Det skiljer på **byggt**, **bevisat här** och **måste bevisas på din
Windows-dator**.

---

## 1. Naturlig röst utan nyckel och utan nedladdning

`packages/voice-engine/src/neural-voice.ts`

Windows 11 har redan neurala röster (Guy, Andrew, Brian, Aria, Jenny, Mattias,
Sofie). De nås via Edge Read-Aloud-tjänsten, syntetiseras i molnet och spelas upp
av Windows självt.

Alternativen som valdes bort, och varför:

| Alternativ | Varför inte |
| --- | --- |
| Piper (lokal neural TTS) | Kräver nedladdning av modellfiler (~60 MB) + `onnxruntime`-binär. Fungerar offline, men är ett installationssteg och en binär vi måste lita på. |
| Att jaga en DLL | Det finns ingen "röst-DLL" att ladda ner. Windows-röster är antingen SAPI (robot) eller SAPI5-paket som installeras via Inställningar → Åtkomst. Neuronal röst i Windows kräver antingen Edge-tjänsten eller en molnnyckel. |
| ElevenLabs / OpenAI TTS | Kräver nyckel och kostar pengar per tecken. Finns redan i koden men **anropades aldrig** — se bugg 2 nedan, nu fixat. |

**Ärligt om avvägningen:** neural röst kräver nät. SAPI är offline men låter
sämre. Appen använder neural först, faller tillbaka till SAPI, och **säger vilken
den använde** (`engine` i svaret). Den påstår aldrig att den spelade en naturlig
röst när den spelade en robot.

```bash
studdy voice "Hej, det här är Buddy."
# { ok, engine: "neural" | "sapi", providerNote, fallenBackBecause }

studdy voice-check          # syntetiserar och rapporterar riktiga byte, spelar inte
studdy voice-check --voice aria
studdy voice "..." --sapi   # tvinga offline-rösten
```

`/voice voices` i chatten listar båda sorterna, med skillnaden utskriven.

## 2. Autopilot-minne — inget `/remember` behövs

`packages/core/src/obsidian-memory.ts`, `extractProfileFact` + `rememberProfileAuto`

Varje mening du skriver går genom en **regelbaserad** extraktion. Den sparar bara
något när fyra villkor gäller samtidigt:

1. det är ett påstående, inte en fråga,
2. det handlar om dig (meningen börjar i första person; "appen fungerar inte"
   räknas inte),
3. det innehåller en identitet eller preferens ("jag pluggar…", "jag föredrar…",
   "my exam is…"),
4. det innehåller **ingen** hemlighet, e-post, telefon, personnummer eller URL.

Dubbletter filtreras på ordöverlapp (≥70 % = samma fakta i andra ord). Allt hamnar
i `Obsidian-Vault/Profile.md`, som du kan läsa och radera.

Det är **extraktion, inte inferens**. Appen gissar aldrig en fakta du inte sagt,
eftersom ett felaktigt minne om en person är värre än inget minne.

Bevisat här, genom den byggda CLI:n, **utan AI-provider inkopplad**:

```
$ studdy ask "Jag pluggar till nätverkstekniker och föredrar korta svar"
Ingen AI-provider är ansluten ännu...

$ cat $STUDDY_DATA_DIR/Obsidian-Vault/Profile.md
- Jag pluggar till nätverkstekniker och föredrar korta svar
```

## 3. Proaktivitet som inte spammar

Före: CLI:t skrev ut **varje** tips observatören producerade, en gång i sekunden.
`ProactiveGovernor` fanns i koden men anropades aldrig — ett reglage utan koppling.

Nu: `runtime.takeProactiveHints()` frågar governorn först. Ett tips per cooldown
(3 min NORMAL, 10 min QUIET), aldrig 22:00–07:00, aldrig under prov, och relevans
härleds ur den faktiska signalen (observerat fel = 0.95, allmän kontext = 0.5).
När något undertrycks loggas **skälet**, så det går att se varför den var tyst.

```bash
/proactive            # visa läge + varför den är tyst eller inte
/proactive quiet      # 10 min mellan tips
/proactive normal     # 3 min
/proactive off        # inga oombedda meddelanden
```

Bevisat här (byggd CLI):

```
Proaktivitet: QUIET · tysta timmar 22–07 · aldrig under prov.
Proaktivitet: NORMAL · får ta initiativ nu
Proaktivitet: OFF · tyst nu — Proaktiva tips är avstängda.

23:30 NORMAL -> OFF          (tysta timmar vinner över valt läge)
13:00 NORMAL -> NORMAL (3 min)
13:00 QUIET  -> QUIET (10 min)
```

## 4. Två buggar som bara syntes när koden faktiskt kördes

1. **`createRequire` krockade i bundlen.** CLI:t kraschade med
   `SyntaxError: Identifier 'createRequire' has already been declared` — men bara
   i `dist/cli/studdy.mjs`, aldrig i tester eller typecheck. Fixat genom att
   importera `ws` direkt.
2. **Premium-TTS var oåtkomlig.** `ElevenLabsProvider` och `OpenAiTtsProvider`
   fanns, men `SpeechPlayer` anropade **hårdkodat** `WindowsNativeProvider`. Ingen
   inställning kunde nå dem. Neural-vägen är nu inkopplad och valbar.

## 5. Vad som INTE är bevisat, och varför

| Sak | Status |
| --- | --- |
| Att rösten låter naturlig | **INTE BEVISAT HÄR.** Sandlådan blockerar TLS till `speech.platform.bing.com` (`SSL_ERROR_SYSCALL`), så ingen syntes har körts. Koden är byggd, typer och tester gröna, men första riktiga ljudet måste komma från din dator eller CI. |
| Att uppspelningen hörs | Kräver Windows + ljudenhet. `playAudioOnWindows` använder `System.Windows.Media.MediaPlayer`. |
| Att mikrofonen fungerar | Kräver din mikrofon. `studdy voice-check` bevisar bara ut-ljudet. |
| 24/7 medveten | Nej. Autostart startar ett `cmd`-fönster vid inloggning; stängs det eller datorn sover är den borta. |
| "Se allt" | Nej, och ska inte påstås. Toppnivåfönster + tillgänglighetsträd. Skyddade fält, banker, incognito och rå pixlar läses medvetet inte. |

## 6. Kör detta på din dator och klistra in svaret

```powershell
studdy --version                      # måste vara versionen med denna PR
studdy voice-check                    # ok:true + byte > 0 = rösten syntetiserar
studdy voice "Hej! Nu ska du höra en naturlig röst."   # engine: neural
studdy voice "..." --sapi             # engine: sapi, för jämförelse
studdy voice-check --voice aria        # annan röst
studdy voice-check                    # medflygsläge: ska ge tydligt fel, inte hänga
```

Om `voice-check` ger `ok:false` med ett nätverksfel är det nätet, inte koden —
säg till så byter vi till den lokala Piper-vägen istället.
