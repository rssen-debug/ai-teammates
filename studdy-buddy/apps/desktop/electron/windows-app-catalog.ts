import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function shortcutName(value: string): string {
  return value.toLocaleLowerCase('sv-SE').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function startMenuRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.APPDATA ? join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    env.ProgramData ? join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
  ].filter((p): p is string => Boolean(p));
}
/**
 * Find a Windows Start-menu .lnk WITHOUT executing any text from the chat.
 * No PowerShell, cmd /c, path concatenation from user input, or arbitrary files.
 * Return null on an ambiguous name rather than opening the wrong program.
 */
export function findStartMenuApp(requested: string, roots = startMenuRoots()): string | null {
  const key = shortcutName(requested);
  if (!key || key.length > 80) return null;
  const items: { label: string; file: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || items.length >= 2500) return;
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (items.length >= 2500) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
        items.push({ label: shortcutName(entry.name.slice(0, -4)), file: path });
      }
    }
  };
  for (const root of roots) walk(root, 0);
  const exact = items.filter(item => item.label === key);
  if (exact.length) return exact[0]!.file;
  const prefix = items.filter(item => item.label.startsWith(key + ' '));
  if (prefix.length === 1) return prefix[0]!.file;
  const substring = items.filter(item => item.label.includes(key));
  return substring.length === 1 ? substring[0]!.file : null;
}
