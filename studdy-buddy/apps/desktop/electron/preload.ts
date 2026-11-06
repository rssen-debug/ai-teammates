import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@studdy/shared';

/**
 * Preload: the ONLY bridge between the sandboxed renderer and the main process.
 *
 * Security rules enforced here:
 *  - an explicit allow-list of channels; no dynamic channel names
 *  - no Node APIs are exposed (no fs, no child_process, no require)
 *  - streaming events are forwarded through one narrow subscription
 *  - every invoke returns the Result envelope, so the renderer handles errors
 *    explicitly instead of catching exceptions from the bridge
 */

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api = {
  version: 1,

  app: {
    info: () => invoke(IPC.appInfo),
    quit: () => invoke(IPC.appQuit),
  },

  window: {
    setIgnoreMouse: (ignore: boolean) => invoke(IPC.windowSetIgnoreMouse, ignore),
    setExpanded: (expanded: boolean) => invoke(IPC.windowSetExpanded, expanded),
    setPosition: (x: number, y: number) => invoke(IPC.windowSetPosition, x, y),
    getBounds: () => invoke(IPC.windowGetBounds),
    displays: () => invoke(IPC.windowDisplays),
  },

  chat: {
    send: (payload: unknown) => invoke(IPC.chatSend, payload),
    cancel: () => invoke(IPC.chatCancel),
    history: () => invoke(IPC.chatHistory),
    reset: () => invoke(IPC.chatReset),
    onStream: (listener: (event: unknown) => void) => {
      const wrapped = (_e: unknown, event: unknown) => listener(event);
      ipcRenderer.on(IPC.chatStreamEvent, wrapped);
      return () => ipcRenderer.removeAllListeners(IPC.chatStreamEvent);
    },
  },

  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch: unknown) => invoke(IPC.settingsUpdate, patch),
  },

  provider: {
    list: () => invoke(IPC.providerList),
    save: (patch: unknown) => invoke(IPC.providerSave, patch),
    test: () => invoke(IPC.providerTest),
  },

  permissions: {
    get: () => invoke(IPC.permissionsGet),
    grant: (key: string) => invoke(IPC.permissionsGrant, key),
    revoke: (key: string) => invoke(IPC.permissionsRevoke, key),
    setMode: (mode: string) => invoke(IPC.permissionModeSet, mode),
  },

  observe: {
    windows: () => invoke(IPC.windowsList),
    snapshot: (windowId: string) => invoke(IPC.snapshotTake, windowId),
    capture: (windowId: string) => invoke(IPC.screenCapture, windowId),
    sources: () => invoke(IPC.screenSources),
    cursorContext: () => invoke(IPC.cursorContext),
  },

  bridge: {
    status: () => invoke(IPC.bridgeStatus),
    rotateToken: () => invoke(IPC.bridgeRotateToken),
    sites: () => invoke(IPC.bridgeSitesGet),
    addSite: (site: string) => invoke(IPC.bridgeSitesAdd, site),
    removeSite: (site: string) => invoke(IPC.bridgeSitesRemove, site),
    pageGraph: () => invoke(IPC.pageGraph),
    onPage: (listener: (event: unknown) => void) => {
      const wrapped = (_e: unknown, event: unknown) => listener(event);
      ipcRenderer.on(IPC.pageContext, wrapped);
      return () => ipcRenderer.removeListener(IPC.pageContext, wrapped);
    },
    onSelection: (listener: (event: unknown) => void) => {
      const wrapped = (_e: unknown, event: unknown) => listener(event);
      ipcRenderer.on(IPC.selectionContext, wrapped);
      return () => ipcRenderer.removeListener(IPC.selectionContext, wrapped);
    },
  },

  overlay: {
    highlight: (plan: unknown) => invoke(IPC.overlayHighlight, plan),
    clear: () => invoke(IPC.overlayClear),
  },

  learning: {
    snapshot: () => invoke(IPC.learningSnapshot),
    evidence: (input: unknown) => invoke(IPC.learningEvidence, input),
    resume: () => invoke(IPC.sessionResume),
  },

  voice: {
    speak: (text: string) => invoke(IPC.voiceSpeak, text),
    stop: () => invoke(IPC.voiceStop),
    test: () => invoke(IPC.voiceTest),
  },

  diagnostics: {
    run: () => invoke(IPC.diagnosticsRun),
  },
};

contextBridge.exposeInMainWorld('studdy', api);

export type StuddyBridge = typeof api;
