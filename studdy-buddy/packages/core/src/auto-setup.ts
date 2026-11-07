import type { PermissionKey, PermissionMode } from '@studdy/shared';

export interface AutoSetupStore {
  checkpoints: { get<T>(key: string): T | null | undefined; set(key: string, value: unknown): void };
  permissions: { grant(key: PermissionKey): void; setMode(mode: PermissionMode): void; isGranted(key: PermissionKey): boolean };
}

export const FULL_DESKTOP_SCOPES: PermissionKey[] = [
  'application.observe', 'screen.capture', 'browser.read', 'computer.actions', 'provider.dataShare',
  // The microphone was missing here, so "Full åtkomst" left it denied while the
  // voice modes used it anyway. Either the permission means something or it
  // should not exist; this makes it mean something.
  'microphone',
];
const SETUP_KEY = 'desktop.full-access.v1';
const CLI_SETUP_KEY = 'cli.full-access.v1';

export function configureFullDesktopAccess(store: AutoSetupStore, platform: string, isPackaged: boolean): boolean {
  if (platform !== 'win32' || !isPackaged) return false;
  if (store.checkpoints.get<boolean>(SETUP_KEY)) return false;
  for (const scope of FULL_DESKTOP_SCOPES) store.permissions.grant(scope);
  store.permissions.setMode('APPROVED_ACTION');
  store.checkpoints.set(SETUP_KEY, true);
  return true;
}

/** Explicit CLI first-run setup. One-time; respects later revokes. */
export function configureCliFullAccess(store: AutoSetupStore): boolean {
  if (store.checkpoints.get<boolean>(CLI_SETUP_KEY)) return false;
  for (const scope of FULL_DESKTOP_SCOPES) store.permissions.grant(scope);
  store.permissions.setMode('APPROVED_ACTION');
  store.checkpoints.set(CLI_SETUP_KEY, true);
  return true;
}
