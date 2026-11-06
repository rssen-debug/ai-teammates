/** Deterministic chat intent parsing. Generic launcher: no hardcoded browser aliases. */
export interface LaunchIntent { programName: string; openMemory: boolean; }
const LAUNCH_RE = /^(?:(?:kan du|could you|please|snälla)\s+)?(?:öppna|starta|kör|open|launch|start)\s+(?:(?:upp|min|mitt|the|my|en|ett|appen|programmet)\s+)?(.+?)(?:\s+(?:åt mig|nu|please|är du snäll))?[.!?]*$/i;
const MEMORY_RE = /^(?:mitt\s+)?(?:minne|minnet|obsidian(?:\s+vault)?|memory)(?:\s+mapp(?:en)?)?$/i;
export function parseLaunchIntent(text: string): LaunchIntent | null {
  const match = text.trim().match(LAUNCH_RE);
  const programName = (match?.[1]?.trim() ?? '').replace(/^["'](.+)["']$/, '$1').replace(/[.,;:!?]+$/, '').trim();
  if (!match || !programName) return null;
  return { programName, openMemory: MEMORY_RE.test(programName) };
}
export function isInboxRequest(text: string): boolean {
  return /^(?:visa|kolla|läs|hämta|show|check|read)(?:\s+(?:mina|min|my|the))?\s+(?:senaste\s+)?(?:gmail|mejl|mail|emails|inbox|inkorgen)(?:\s+(?:senaste|latest))?[.!?]*$/i.test(text.trim());
}
export function isStartLiveRequest(text: string): boolean {
  return /^(?:starta\s+live|aktivera\s+(?:live|observation|skärmläsning)|enable\s+(?:live|observation)|du\s+får\s+(?:se|läsa)\s+min\s+skärm)[.!?]*$/i.test(text.trim());
}
export function isLiveQuestion(text: string): boolean {
  return /(?:är\s+du\s+(?:live|online|vaken|aktiv)|(?:vad\s+(?:betyder|innebär).*(?:grön|live))|vad\s+(?:läser|ser|observerar|gör)\s+du\s+(?:just\s+)?nu|vad\s+(?:står|är)\s+det\s+att\s+du\s+läser)/i.test(text);
}
export function isAccessQuestion(text: string): boolean {
  if (parseLaunchIntent(text)) return false;
  return /(?:full(?:a)?\s+(?:permission|behörighet|access|åtkomst)|vilka\s+(?:behörigheter|permissions)|har\s+du\s+(?:tillgång|åtkomst)|kan\s+du\s+(?:styra|öppna\s+program)|vad\s+(?:kan|får)\s+du\s+göra)/i.test(text);
}
export function isScreenQuestion(text: string): boolean {
  return /(?:sk[aä]rm|f[oö]nster|screen|vad ser du|what do you see|what is on|kolla vad jag|titta p[aå])/i.test(text);
}
