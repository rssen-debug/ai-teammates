/**
 * IPC channel contract shared by Electron main, preload and renderer.
 *
 * The renderer can never touch Node APIs directly (contextIsolation + sandbox).
 * Every channel below is explicitly allow-listed in preload.ts, and every
 * payload is validated on the main-process side before use.
 */

export const IPC = {
  // app / lifecycle
  appInfo: 'app:info',
  appQuit: 'app:quit',
  // window shell
  windowSetIgnoreMouse: 'window:set-ignore-mouse',
  windowSetExpanded: 'window:set-expanded',
  windowSetPosition: 'window:set-position',
  windowGetBounds: 'window:get-bounds',
  windowDisplays: 'window:displays',
  // chat
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatHistory: 'chat:history',
  chatReset: 'chat:reset',
  chatStreamEvent: 'chat:stream-event',
  // settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  providerSave: 'provider:save',
  providerTest: 'provider:test',
  providerList: 'provider:list',
  // permissions
  permissionsGet: 'permissions:get',
  permissionsGrant: 'permissions:grant',
  permissionsRevoke: 'permissions:revoke',
  permissionModeSet: 'permissions:mode-set',
  // observation
  windowsList: 'observe:windows',
  snapshotTake: 'observe:snapshot',
  screenCapture: 'observe:capture',
  screenSources: 'observe:sources',
  observeSelectWindow: 'observe:select-window',
  cursorContext: 'observe:cursor-context',
  // browser bridge (extension -> main). Site-agnostic: any allowed study site.
  bridgeStatus: 'bridge:status',
  bridgeRotateToken: 'bridge:rotate-token',
  bridgeSitesGet: 'bridge:sites-get',
  bridgeSitesAdd: 'bridge:sites-add',
  bridgeSitesRemove: 'bridge:sites-remove',
  pageContext: 'bridge:page-context',
  pageGraph: 'bridge:page-graph',
  selectionContext: 'bridge:selection',
  // packet tracer
  ptObserve: 'pt:observe',
  ptInterpretCli: 'pt:interpret-cli',
  // overlay
  overlayHighlight: 'overlay:highlight',
  overlayClear: 'overlay:clear',
  // learning
  learningSnapshot: 'learning:snapshot',
  learningEvidence: 'learning:evidence',
  sessionResume: 'session:resume',
  // voice
  voiceSpeak: 'voice:speak',
  voiceStop: 'voice:stop',
  voiceTranscribe: 'voice:transcribe',
  voiceTest: 'voice:test',
  // diagnostics
  diagnosticsRun: 'diag:run',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export type PermissionKey =
  | 'screen.capture'
  | 'application.observe'
  | 'browser.read'
  | 'microphone'
  | 'computer.actions'
  | 'provider.dataShare';

export type PermissionMode = 'OBSERVE_ONLY' | 'VISUAL_GUIDE' | 'APPROVED_ACTION';

export interface PermissionState {
  key: PermissionKey;
  granted: boolean;
  grantedAt: string | null;
  mode: PermissionMode;
}

export interface StreamEvent {
  sessionId: string;
  messageId: string;
  /** Incremental token payload. */
  delta?: string;
  done?: boolean;
  error?: string;
  /** Final structured parse when the response completed successfully. */
  structured?: unknown;
}

export interface ChatSendRequest {
  text: string;
  mode?: string;
  /** Context the agent gathered locally; the renderer just passes it through. */
  context?: {
    selectedText?: string;
    pageTitle?: string;
    courseName?: string;
    currentNodeTitle?: string;
    appKind?: string;
    windowTitle?: string;
  };
}

/**
 * Discriminated result envelope.
 *
 * This is a union rather than `{ ok: boolean; data?: T }` on purpose: a boolean
 * flag does not narrow, so every call site would need a non-null assertion. With
 * the union, `if (result.ok)` guarantees `result.data` exists and the compiler
 * proves we never read an error payload as data.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T = never>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}
