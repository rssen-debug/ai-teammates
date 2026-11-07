import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Per-user login startup, not a Windows service and not 24/7 while asleep. */
export function windowsStartupFolder(env: NodeJS.ProcessEnv = process.env): string | null {
  const appdata = env.APPDATA?.trim();
  if (!appdata) return null;
  return join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function configureLoginAutostart(
  enabled: boolean | null,
  options: { platform?: string; env?: NodeJS.ProcessEnv; folder?: string } = {},
): { ok: boolean; enabled: boolean; detail: string } {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { ok: false, enabled: false, detail: 'Inloggningsstart stöds här endast på Windows.' };
  }
  const folder = options.folder ?? windowsStartupFolder(options.env);
  if (!folder) return { ok: false, enabled: false, detail: 'APPDATA saknas. Kunde inte hitta Windows Autostart.' };
  const path = join(folder, 'Studdy-Buddy.cmd');
  try {
    if (enabled === true) {
      mkdirSync(folder, { recursive: true });
      // No secrets or absolute user paths in the startup file.
      writeFileSync(path, '@echo off\r\nstart "" cmd.exe /k studdy\r\n', { encoding: 'utf8', mode: 0o600 });
    } else if (enabled === false && existsSync(path)) {
      unlinkSync(path);
    }
    const active = existsSync(path);
    return {
      ok: true, enabled: active,
      detail: active
        ? 'Buddy startar när du loggar in på Windows. Måste hållas öppet; stoppar vid avstängning, sömn eller utloggning.'
        : 'Ingen automatisk start vid Windows-inloggning.',
    };
  } catch {
    return { ok: false, enabled: false, detail: 'Kunde inte ändra Windows autostart. Ingen åtgärd utförd.' };
  }
}
