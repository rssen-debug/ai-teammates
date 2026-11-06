import type { ChatMessage, ModelCapabilities, PermissionKey, PermissionMode, ProviderConfig, Settings } from '@studdy/shared';

/**
 * Renderer-side view of the preload bridge.
 *
 * The renderer is a sandboxed browser context: no Node, no filesystem. Everything
 * it can do is declared here, so adding a capability to the app means editing
 * this interface *and* preload.ts - which is exactly the friction we want.
 */

export type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface StuddyBridge {
  app: {
    info(): Promise<BridgeResult<{ version: string; platform: string; isDev: boolean; dataDir: string; accessibility: string }>>;
    quit(): Promise<BridgeResult<boolean>>;
  };
  window: {
    setIgnoreMouse(ignore: boolean): Promise<BridgeResult<boolean>>;
    setExpanded(expanded: boolean): Promise<BridgeResult<boolean>>;
    setPosition(x: number, y: number): Promise<BridgeResult<boolean>>;
    getBounds(): Promise<BridgeResult<{ x: number; y: number; width: number; height: number } | null>>;
    displays(): Promise<BridgeResult<{ id: string; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number; isPrimary: boolean }[]>>;
  };
  chat: {
    send(payload: { text: string; mode?: string; context?: Record<string, unknown> }): Promise<
      BridgeResult<{ message: ChatMessage; degraded: boolean; error: string | null; trimmed: boolean; notice: string | null }>
    >;
    cancel(): Promise<BridgeResult<boolean>>;
    history(): Promise<BridgeResult<ChatMessage[]>>;
    reset(): Promise<BridgeResult<boolean>>;
    onStream(listener: (event: unknown) => void): () => void;
  };
  settings: {
    get(): Promise<BridgeResult<Settings>>;
    update(patch: Partial<Settings>): Promise<BridgeResult<Settings>>;
  };
  provider: {
    list(): Promise<BridgeResult<(ProviderConfig & { hasApiKey: boolean })[]>>;
    save(patch: Partial<ProviderConfig> & { apiKey?: string }): Promise<BridgeResult<ProviderConfig>>;
    test(): Promise<BridgeResult<{ ok: boolean; detail: string; latencyMs: number }>>;
  };
  permissions: {
    get(): Promise<BridgeResult<{ key: PermissionKey; granted: boolean; grantedAt: string | null; mode: PermissionMode }[]>>;
    grant(key: PermissionKey): Promise<BridgeResult<unknown>>;
    revoke(key: PermissionKey): Promise<BridgeResult<unknown>>;
    setMode(mode: PermissionMode): Promise<BridgeResult<unknown>>;
  };
  observe: {
    windows(): Promise<BridgeResult<unknown[]>>;
    snapshot(windowId: string): Promise<BridgeResult<unknown>>;
    capture(windowId: string): Promise<BridgeResult<{ id: string; name: string; png: string }>>;
    sources(): Promise<BridgeResult<{ id: string; name: string }[]>>;
    selectWindow(sourceId: string | null): Promise<BridgeResult<{ title: string | null }>>;
    liveStatus(): Promise<BridgeResult<{ connected: boolean; observing: boolean; windowTitle: string | null; lastObservedAt: number | null }>>;
    onCompanionHint(listener: (event: { text: string; kind: string }) => void): () => void;
    cursorContext(): Promise<BridgeResult<{ point: { x: number; y: number }; displayId: string }>>;
  };
  bridge: {
    status(): Promise<
      BridgeResult<{
        running: boolean;
        port: number | null;
        host: string;
        clients: number;
        detail: string;
        allowedSites: string[];
        pendingSites: string[];
        token: string;
        observation: { url: string | null; title: string | null; nodeCount: number } | null;
      }>
    >;
    rotateToken(): Promise<BridgeResult<{ token: string }>>;
    sites(): Promise<BridgeResult<string[]>>;
    addSite(site: string): Promise<BridgeResult<string[]>>;
    removeSite(site: string): Promise<BridgeResult<string[]>>;
    pageGraph(): Promise<BridgeResult<unknown>>;
    onPage(listener: (event: unknown) => void): () => void;
    onSelection(listener: (event: unknown) => void): () => void;
  };
  overlay: {
    highlight(plan: unknown): Promise<BridgeResult<boolean>>;
    clear(): Promise<BridgeResult<boolean>>;
  };
  learning: {
    snapshot(): Promise<BridgeResult<unknown>>;
    evidence(input: unknown): Promise<BridgeResult<unknown>>;
    resume(): Promise<
      BridgeResult<{ greeting: string | null; lastNodeTitle: string | null; dueReviews: string[]; recentTopics: string[] }>
    >;
  };
  voice: {
    speak(text: string): Promise<BridgeResult<boolean>>;
    stop(): Promise<BridgeResult<boolean>>;
    test(): Promise<BridgeResult<{ provider: string; configured: boolean; detail: string }[]>>;
  };
  diagnostics: {
    run(): Promise<BridgeResult<unknown>>;
    githubStatus(): Promise<BridgeResult<{ repository: string; enabled: boolean; hasToken: boolean; target: string }>>;
    githubConfigure(config: { repository: string; token?: string; enabled: boolean }): Promise<BridgeResult<{ repository: string; enabled: boolean; hasToken: boolean; target: string }>>;
    githubSyncNow(): Promise<BridgeResult<{ ok: boolean; detail: string }>>;
  };
}

declare global {
  interface Window {
    studdy?: StuddyBridge;
  }
}

/**
 * Accessor that fails loudly in a real browser instead of silently doing nothing.
 * When the app is opened outside Electron (e.g. the design preview) this returns
 * null and the UI switches to its honest "no bridge" state.
 */
export function getBridge(): StuddyBridge | null {
  return typeof window !== 'undefined' ? (window.studdy ?? null) : null;
}

export interface ChatUiLike {
  messages: ChatMessage[];
  capabilities: ModelCapabilities | null;
}
