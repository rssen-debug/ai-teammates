# MAJIN — developer handover, provider/update audit v0.9.3

## Behåll UI/UX
BEHÅLL Aurora-designen från v0.9.2: färger, layout, contextual Workspace, ren chatt, den enkla välkomstytan och runda animerade Send/Stop. Återinför inte debugspam, dashboard-väggar, slogans eller förslagschips. Detta är ett uttryckligt krav från användaren. Provideralternativen ligger i anslutningspanelen; huvudchatten ska förbli ren.

## OpenCode: vad fungerar och vad återstår?
Live den 19 oktober 2026 med användarens nyckel (nyckeln finns inte i dokumentet):

| Kontroll | Resultat |
| --- | --- |
| Zen GET /zen/v1/models | 200, 47 modeller |
| Go GET /zen/go/v1/models | 200, 37 modeller |
| Zen POST chat/completions, longcat-2.5-preview-free, max 16 tokens | 403, FreeTierError |
| Go via MAJIN complete(), LongCat Free, max 128, 19:33:51 UTC | OK, stop, 52 tokens |
| Go via MAJIN complete(), streaming, max 128, 19:34:08 UTC | OK, deltas OK, stop, 38 tokens |
| Riktiga /api/chat + agentloop, Go LongCat Free, 19:35:08 UTC | HTTP 200, ok=true, text OK, 1 steg, inga verktyg |

Det senaste testet FUNGERAR via Go: både vanlig transport, streaming och hela appens riktiga /api/chat + agentloop svarade OK i en isolerad MAJIN-process. Appanropet använde 1706 input/25 output-tokens, 1 steg och inga verktyg. API:t markerade priceKnown=false; nollan i costUsd är därför ingen separat faktureringsverifiering. Zen nekade samma fria modell med app-only FreeTierError tidigare i denna audit. Ett första Go-prov med max 16 gav tom text vid den mycket låga tokenbudgeten; max 128 gav OK. Bildens blandning av 200 och 403 är förenlig med dessa varierande resultat. Tidigare audit fick också 403. Inget av detta bevisar en ogiltig nyckel. Ingen betald modell eller fallback har använts. Prisfältet i modellistan saknas; transportens costUsd=0 är inte separat bevis för kontofakturering. Den valda LongCat-modellen är dokumenterad som gratis av OpenCode.

Dev behöver bevaka: Go fungerar i senaste liveprovet, men verifiera konto-/free-tier-behörighet med OpenCode om 403 återkommer. Behåll separata Go- och Zen-endpoints. Försök inte låtsas vara OpenCode med förfalskade klientheaders. Om tjänsten fortsätter neka måste användaren välja en annan provider. Katalog-200 är aldrig bevis för fungerande inferens.

## Providerfixar i denna leverans
- src/core/provider/catalog.js är gemensam källa för /api/models och majin.provider(action=models).
- OpenAI-kompatibla API:er: Bearer, custom headers och keyEnv; vendor/model-ID bevaras.
- Anthropic: native /v1/models, x-api-key, anthropic-version och after_id-pagination. Chat använder befintlig Messages-adapter.
- Gemini: native lista med x-goog-api-key/pageToken, chat-kandidater får rätt ID utan models/-prefix. Chat använder dokumenterad /v1beta/openai/chat/completions-adress.
- Qwen/Alibaba: eget preset, regional/workspace-endpoint kan ändras i Connection options. Native /api/v1/models med page_no/total och metadata för kontext/tools/vision. Nyckelns region och endpoint måste matcha.
- Separat OpenCode Zen-preset; befintlig Go-anslutning skrivs inte om.
- Full katalog sparas, ingen tyst gräns vid 400 modeller. UI paginerar renderingen. Saknade priser blir Price unknown, aldrig Free. Ett namn som slutar på -free räcker inte för att verifiera pris eller kontoåtkomst.
- Nätfel, trasiga kataloger, misslyckad sida eller ofullständig pagination blir fel; senaste fungerande sparade katalog bevaras. Ingen nyckel skickas vidare till annan origin vid pagination.
- Custom endpoint har eget anslutningsnamn och val av OpenAI-compatible/Anthropic/Gemini. Nya anslutningar uppdaterar providerlistan före modellval. Inga automatiska betalda provanrop vid anslutning.

## Update direkt från appen
Windowsflödet är: update -> bekräfta install -> ladda ner och verifiera installer -> Windows bekräftar processstart -> gamla backend stänger -> detached watchdog väntar -> nya exe startar. Keys/minne/data ligger utanför programfilerna.

Fixat: bekräftelseläge överlever statusrefresh, dubbla installeranrop blockeras, startfel rapporteras utan att stänga MAJIN. Senaste versionen döljer update-knappen. Live GitHub-check av v0.9.2 mot då senaste v0.9.2 gav up_to_date, tom notice och rätt installerasset.

Klienten från v0.9.3 refreshar efter SSE-återanslutning. Byte av backendversion laddar om UI och återställer samtals-ID och osänt utkast i sessionStorage. Uppgraderar användaren från en äldre klient (t.ex. v0.9.2) kan ett manuellt reload/återöppna behövas för att först få den nya klientkoden.

Dev behöver fortsatt verifiera: en komplett uppgradering från en äldre installerad release via riktiga appknappen och watchdog på en separat Windows-VM, inklusive att ny UI-version faktiskt syns och senaste update-knappen försvinner. Installer-installation/omstart/avinstallation/ominstallation i CI och UI-kontraktstester är separata bevis; de ska inte beskrivas som att detta fullständiga äldre->nyare-scenario redan har körts på användarens installation. Installera inte över användarens data för att testa.

## Testgränser och fortsatt arbete
Protokoll- och HTTP-integrationer använder kontrollerade lokala servrar, inga andra kundnycklar finns här. Det går inte att garantera att varje kundkonto har krediter, kvot eller åtkomst. Gör små uttryckligt godkända liveprover med riktiga DeepSeek-, Qwen-, Gemini- och Anthropic-konton före sådana löften.

”Universal” betyder stöd för dessa API-protokoll och konfigurerbara endpoints. Responses-only-modeller, AWS SigV4, Azure-specifika versionerade URL:er och andra autentiseringsprotokoll kan kräva egna adaptrar. Utöka med verkliga kontraktstester, inte modellnamnsgissningar. Alla leverantörer lämnar inte ut pris, verktygsstöd eller exakt kontobehörighet via modellistan; okänd metadata måste fortsätta vara okänd.

## Verifiering hittills
- Full lokal Windows-svit: 441 tester, 426 pass, 15 skip, 0 fail.
- Nya tester: Anthropic/Gemini/Qwen-pagination, cross-origin-skydd, miljönycklar, full katalog >400 via riktig HTTP-route, bevarad katalog efter 401, riktiga lokala chat-anrop för tre protokoll och Windows installer-startfel/startack.
- Edge browser: update-knapp vid senaste version, bekräftelse/dubbelklick, versionsbyte med draft/session-restore samt tidigare UI-acceptans. Custom Anthropic-provider med eget namn sparades genom riktig API-route och valdes i model picker.
- Ingen betald inferens. Senaste Go-inferensen fungerar; Zen/app-only-403 och varierande kontobehörighet kvarstår som bevakning, inte ett globalt förbud.
- CI, merge och release-länkar fylls i arbetschattens outputs/handover.md efter leverans.

## Officiella protokollreferenser
- Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
- Anthropic model list: https://platform.claude.com/docs/en/api/models/list
- Alibaba modellista: https://www.alibabacloud.com/help/en/model-studio/list-models
- Alibaba endpoint/kompatibilitet: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
- OpenCode modeller/API: https://opencode.ai/v2/docs/console/models/
