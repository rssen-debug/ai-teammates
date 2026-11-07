/** Route explicit instructions about desktop UI to Kilo's real tool loop.
 * Ordinary questions and writing requests stay in the conversation model.
 * This does not authorize external sending, purchases or irreversible actions.
 */
export function naturalDesktopGoal(input: string): string | null {
  const text = input.trim();
  if (text.length < 9 || text.length > 1000 || text.startsWith('/')) return null;
  const direct = /^(?:hey\s+)?buddy[,! ]+\s*(?:do|gör|fixa|utför)\s+(.{4,})$/i.exec(text);
  if (direct) return direct[1]!.trim();
  const action = /^(?:(?:buddy[,! ]+)?(?:please|snälla|kan du|could you|can you)\s+)?(?:click|type|inspect|navigate|scroll|select|klicka|skriv in|undersök|navigera|skrolla|välj)\b/i;
  const target = /\b(?:screen|window|browser|chrome|tab|button|input field|desktop|computer|skärm(?:en)?|fönster|webbläsare|flik(?:en)?|knapp(?:en)?|fält(?:et)?|dator(?:n)?|program(?:met)?)\b/i;
  return action.test(text) && target.test(text) ? text : null;
}
