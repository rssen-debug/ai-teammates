# MAJIN V5 CLI — slutförandeuppdrag

Du ansvarar för att slutföra MAJIN V5 CLI i `rssen-debug/MAJINCLI`. Genomför arbetet, testa och leverera senaste fungerande versionen. Stanna inte vid en rapport eller handover.

## Mål

Användaren skriver eller säger en uppgift. Majin väljer rätt verktyg, utför arbetet, visar vad som händer och verifierar resultatet. Samma motor, verktyg, sparade behörigheter och historik ska användas genom CLI och UI.

Ingen lobotomi: ta inte bort funktioner, dölj inte verktyg och lägg inte till godtyckliga begränsningar för att göra tester gröna. Återanvänd det som redan byggts i V1–V5.

## 1. Fastställ aktuellt läge

- Läs repots instruktioner och relevanta överlämningar. Kontrollera aktuell main, öppna PR:er, CI och senaste publicerade version.
- PR #451 var mergad vid senaste granskningen. PR #454 innehöll en fix för att `serve --all-lanes` ignorerade uttryckliga behörigheter. Kontrollera deras aktuella status.
- Äldre dokument och PR-beskrivningar kan vara inaktuella. Utgå från körbar kod på aktuell commit.
- Godta inte ”97/100” utan reproducerbara bevis.

## 2. Slutför behörigheterna

- Granska och slutför #454 eller motsvarande fix.
- Kontrollera att run, chat, resume, serve och UI använder samma beständiga behörighetsmodell.
- Jag vill kunna aktivera alla tillgängliga verktygsområden genom ett tydligt ägarläge, en gång, och sedan slippa upprepade frågor inom det mandatet.
- Sparade behörigheter, mappar och webbdomäner ska överleva omstart och gälla i den faktiska körningen.
- Återkallelse och stopp ska fungera.
- Modelltext, webbsidor och importerade filer får aldrig själva ge behörigheter.
- Håll isär Majin-behörigheter, OS-administratör och åtkomst till externa konton.

## 3. Koppla in återstående verktyg

- Inventera hela verktygsuniversumet programmässigt och jämför med vad modellen faktiskt kan upptäcka och köra.
- Återanvänd befintliga bryggor, registries och tjänster. Bygg inte en ny parallell agentmotor.
- Koppla in kvarvarande användbara värdtjänster och integrationer genom rätt körväg.
- För varje verktyg ska katalogen visa: tillgängligt, saknad behörighet, saknat beroende, fel plattform eller saknad konfiguration.
- Ett verktyg som bara listas räknas inte som fungerande.
- Om en äldre funktion ersatts ska katalogen visa den fungerande ersättaren.
- Modellen ska kunna söka fram och använda rätt verktyg utan att hela katalogen behöver ligga i varje prompt.

## 4. Verifiera hela CLI-flödet

Kontrollera:

- Naturlig instruktion och terminalchatt.
- Modellval och sparad provider efter omstart.
- Rätt verktyg och giltiga argument.
- Synlig status, verktygsanrop, resultat och fel utan hemligheter i loggar.
- Paus, stopp, styrning, kö och återupptagning.
- Återhämtning efter processavbrott och providerfel.
- Långa uppgifter med synlig budget och sparad checkpoint.
- Inga dubbla externa effekter vid resume eller osäkra svar.
- COMPLETED först efter oberoende verifiering. Skilj tydligt på klart, delvis klart, väntar på användaren och fel.

## 5. Kör riktiga acceptanstester

Testa på aktuell slutcommit:

- Skapa, läsa, ändra och verifiera filer inom tillåtna mappar.
- Köra shell/processer och kontrollera resultat.
- Söka och läsa webbsidor.
- Fylla formulär, ladda upp fil, skicka till en kontrollerad testportal och verifiera kvitto.
- Ge en webbdomän behörighet och återuppta samma blockerade uppgift.
- Windows desktop: öppna en app, utföra en uppgift och verifiera utfallet.
- Starta om mitt i ett jobb och återuppta utan dubbla handlingar.
- Köra riktiga modell→verktyg→resultat-anrop med konfigurerad molnprovider.

Använd lokala testportaler för externa skrivtester. Skicka inte riktiga ansökningar, meddelanden, betalningar eller publiceringar enbart som test. Respektera redan givet mandat för verkliga uppgifter.

CAPTCHA och MFA ska upptäckas och hanteras genom användaröverlämning och resume. De ska inte kringgås.

## 6. Tester och leverans

- Kör relevanta regressioner och repots obligatoriska gates, inklusive root-, V4- och V5-tester, syntax och i18n.
- Redovisa överhoppade tester med orsak. Mocktester får inte presenteras som livebevis.
- Om en säkerhetskontroll stoppar en körning: undersök destination och utgående data, rätta grundorsaken och använd en verifierat säker testväg. Kringgå inte kontrollen.
- Använd befintlig Windowsmiljö eller CI för plattformstester. Kör ingen lokal Qwen på min dator.
- Merga först när obligatoriska kontroller är gröna.
- Bygg och publicera genom befintlig releaseprocess. Verifiera installationsfil, SHA256, installation, uppdatering och att installerad version kör rätt commit.
- Säkerhetskopiera användardata före ändringar och bevara nycklar, modellval, minne, historik och behörigheter.
- Om åtkomst eller autentisering saknas: slutför allt oberoende arbete och ange exakt vad som blockerar resten. Hitta inte på lyckade resultat.

## Arbetssätt och rapportering

- Arbeta autonomt inom detta mandat. Be inte om ”kör” mellan rutinmässiga steg.
- Använd parallella agenter för oberoende deluppgifter om miljön stöder det. Undvik samtidiga ändringar i samma filer.
- Fortsätt nyttigt arbete medan tester körs.
- Efter varje färdig arbetsrunda: rapportera vad som fixats, testbevis och återstående punkter.
- Visa gärna procent, men bara beräknad från en fast checklista med verifierade acceptanskriterier. Skilj den från testtäckning och antal tillgängliga verktyg.

## Klart betyder

Alla överenskomna acceptanskriterier är verifierade på slutversionen, alla verktyg som krävs för dem är inkopplade och körbara, behörigheterna fungerar beständigt, obligatorisk CI är grön och den levererade installationen är kontrollerad.

Avsluta med:

1. Commit och mergade PR:er.
2. Tester: PASS / FAIL / SKIPPED / BLOCKED.
3. Verktygstäckning och konkreta kvarvarande begränsningar.
4. Release-URL, version och SHA256.
5. Om min installerade version faktiskt uppdaterats och verifierats.

Börja nu med aktuell GitHub-status och lös sedan återstående punkter tills leveransen är verifierad eller en konkret extern blockerare återstår.
