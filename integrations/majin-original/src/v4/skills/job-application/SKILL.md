Gör endast det ägaren uttryckligen bett om: förbered och fyll i formuläret. Skicka aldrig in ansökan.

1. **Kontrollera verktygen.** Använd endast MAJIN:s registrerade browser-verktyg. Börja med `browser_open` på URL:en som redan finns i samtalet. Skapa aldrig en egen CDP-brygga, starta ingen separat Chrome och använd inte shell/exec för webbläsarautomation.
2. **Observera fälten.** `browser_open` kan redan returnera formulärfält. Annars anropa `browser_form`. Använd exakta observerade etiketter eller f-referenser. Om browser-verktygen saknas, stanna och ange att Web/Browser-lanen eller browser-runtime saknas; gör inga verktygssökningar eller shell-försök.
3. **Fyll i kända uppgifter.** Använd endast uppgifter som ägaren lämnat i samtalet eller verifierade dokument. Gissa aldrig personuppgifter, arbetslivserfarenhet, behörigheter eller fritextsvar. Samla upp till 12 redan observerade fält i ett `browser_form_fill`-anrop. Läs verktygets per-fältresultat; det verifierar att värdena behölls. Om nya villkorliga fält visas, observera dem på nytt innan nästa fyllning.
4. **Hantera hinder säkert.** Lämna lösenord, engångskoder och CAPTCHA till ägaren. Be om en enda precis komplettering om ett obligatoriskt svar saknas; hitta inte på ett svar.
5. **Verifiera och lämna över.** Bekräfta hur många fält som verifierades och vilka obligatoriska fält som återstår. Visa formulärets ifyllda sammanfattning så ägaren kan granska den. `browser_form_fill` skickar inte in formuläret.

**Absolut stoppregel:** anropa aldrig `browser_form_submit` och klicka aldrig på formulärets slutliga skicka-/ansökningsknapp. Detta gäller även om andra webbläsarverktyg föreslår en submit-knapp. Endast ägaren får skicka in ansökan.
