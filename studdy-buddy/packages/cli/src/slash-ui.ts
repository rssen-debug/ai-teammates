/** CLI command discovery and durable goals. No model calls and no hidden actions. */
export interface Goal {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
}
export interface GoalStore {
  get<T>(key: string): T | null | undefined;
  set(key: string, value: unknown): void;
}
export const GOAL_KEY = 'buddy.user-goals.v1';
export const SLASH_COMMANDS = [
  { command: '/api', description: 'Anslut AI-tjänst och nyckel' },
  { command: '/model', description: 'Välj modell i meny' },
  { command: '/models', description: 'Visa aktiv modell' },
  { command: '/goal', description: 'Dina mål och nästa steg' },
  { command: '/do', description: 'Kilo planerar och utför en verifierad datoruppgift' },
  { command: '/voice', description: 'Kontinuerlig CPU-röst med Kilo och avbrytbara svar' },
  { command: '/context', description: 'Visa vad Buddy verkligen kan använda från skärmen' },
  { command: '/status', description: 'Vad Buddy faktiskt gör' },
  { command: '/live', description: 'Livepanel med verkliga observationer' },
  { command: '/debug', description: 'Visa lokala fel från debuggern' },
  { command: '/memory', description: 'Visa Obsidian-minnet' },
  { command: '/autostart', description: 'Starta Buddy vid Windows-inloggning' },
  { command: '/prove', description: 'Verifiera datorstyrning' },
  { command: '/profile', description: 'Personligt minne' },
  { command: '/remember', description: 'Kom ihåg något' },
  { command: '/open', description: 'Öppna program' },
  { command: '/windows', description: 'Visa fönster' },
  { command: '/progress', description: 'Skills baserat på bevis' },
  { command: '/help', description: 'Visa alla kommandon' },
  { command: '/exit', description: 'Avsluta Buddy' },
  // New commands go last: the numbered menu is a contract, and inserting at the
  // top silently renumbers everything a user has learned.
  { command: '/access', description: 'Se och ändra varje behörighet' },
  { command: '/proactive', description: 'Proaktiva tips: off, quiet eller normal' },
] as const;

export function slashMatches(query: string): typeof SLASH_COMMANDS[number][] {
  if (!query.startsWith('/')) return [...SLASH_COMMANDS];
  const needle = query.trim().toLowerCase();
  return SLASH_COMMANDS.filter(item => item.command.startsWith(needle));
}

export function slashCompletions(line: string): [string[], string] {
  const matches = slashMatches(line).map(item => item.command);
  return [matches.length ? matches : [line], line];
}

export const MODEL_CHOICES: Record<string, string[]> = {
  kilo: ['kilo-auto/free'],
  deepseek: ['deepseek-v4-flash'],
  openrouter: ['openrouter/auto'],
  opencode: ['deepseek-v4-flash-free'],
};
export function modelChoices(providerId: string, currentModel: string): string[] {
  return Array.from(new Set([currentModel, ...(MODEL_CHOICES[providerId] ?? [])].filter(Boolean)));
}

export function goals(store: GoalStore): Goal[] {
  const raw = store.get<unknown>(GOAL_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Goal =>
    item !== null && typeof item === 'object' &&
    typeof item.id === 'string' && typeof item.title === 'string' &&
    typeof item.done === 'boolean' && typeof item.createdAt === 'string'
  ).slice(-50);
}
export function addGoal(store: GoalStore, title: string): Goal | null {
  const safe = title.replace(/[\r\n]+/g, ' ').trim().slice(0, 220);
  if (!safe || /(?:api[_ -]?key|password|lösenord|token)\s*[:=]/i.test(safe)) return null;
  const old = goals(store);
  const goal: Goal = { id: String(Math.max(0, ...old.map(item => Number(item.id) || 0)) + 1), title: safe, done: false, createdAt: new Date().toISOString() };
  store.set(GOAL_KEY, [...old, goal].slice(-50));
  return goal;
}
export function completeGoal(store: GoalStore, id: string): boolean {
  const old = goals(store);
  if (!old.some(goal => goal.id === id && !goal.done)) return false;
  store.set(GOAL_KEY, old.map(goal => goal.id === id ? { ...goal, done: true } : goal));
  return true;
}
export function goalSummary(store: GoalStore): string {
  const items = goals(store);
  if (!items.length) return 'Inga mål sparade ännu.';
  return items.map(goal => `${goal.done ? '✓' : '○'} #${goal.id}  ${goal.title}`).join('\n');
}
