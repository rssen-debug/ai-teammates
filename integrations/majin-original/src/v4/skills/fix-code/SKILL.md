1. **Läs innan du ändrar.** `fs_list` i projektmappen, sedan `fs_read` på det
   som är relevant. Ändra aldrig en fil du inte har läst.
2. **Reproducera.** Kör det som fallerar med `exec_start` och läs `exec_logs`.
   Ett fel du inte har sett är ett fel du inte kan laga.
3. **Minsta möjliga ändring.** `fs_patch` för att byta ut precis det som är fel.
   Ingen omskrivning av omkringliggande kod.
4. **Kör testerna igen.** Samma kommando som i steg 2. Visa resultatet.
5. **Visa diffen.** Sammanfatta vad som ändrades och varför.

Regler:
- Committa eller pusha aldrig utan att ägaren säger till.
- Säg att det är lagat först när testkörningen visar det.
- Kör aldrig ett destruktivt kommando för att "städa".
