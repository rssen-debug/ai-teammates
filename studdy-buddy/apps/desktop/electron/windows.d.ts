// Minimal ambient declaration of the Electron API surface this app uses.
//
// We deliberately do NOT depend on the `electron` package's types at build time:
// the package is a devDependency whose binary download is skipped in CI and on
// non-Windows machines, and its launch-time behaviour cannot be exercised here.
// Declaring the narrow surface we touch keeps `npm run typecheck` honest and
// makes it obvious exactly which Electron features the app depends on.

declare module 'electron' {
  export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface Display {
    id: number;
    bounds: Rectangle;
    workArea: Rectangle;
    scaleFactor: number;
    isPrimary?: boolean;
  }

  export interface WebPreferences {
    preload?: string;
    contextIsolation?: boolean;
    sandbox?: boolean;
    nodeIntegration?: boolean;
    webSecurity?: boolean;
    allowRunningInsecureContent?: boolean;
    experimentalFeatures?: boolean;
    devTools?: boolean;
    spellcheck?: boolean;
  }

  export interface BrowserWindowConstructorOptions {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    frame?: boolean;
    transparent?: boolean;
    backgroundColor?: string;
    hasShadow?: boolean;
    resizable?: boolean;
    movable?: boolean;
    minimizable?: boolean;
    maximizable?: boolean;
    fullscreenable?: boolean;
    skipTaskbar?: boolean;
    alwaysOnTop?: boolean;
    focusable?: boolean;
    acceptFirstMouse?: boolean;
    show?: boolean;
    titleBarStyle?: string;
    webPreferences?: WebPreferences;
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    static getAllWindows(): BrowserWindow[];
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    show(): void;
    hide(): void;
    focus(): void;
    close(): void;
    destroy(): void;
    isDestroyed(): boolean;
    isVisible(): boolean;
    setPosition(x: number, y: number): void;
    getPosition(): [number, number];
    setBounds(bounds: Partial<Rectangle>): void;
    getBounds(): Rectangle;
    setAlwaysOnTop(flag: boolean, level?: string): void;
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
    setVisibleOnAllWorkspaces(visible: boolean): void;
    webContents: {
      send(channel: string, ...args: unknown[]): void;
      on(event: string, listener: (...args: unknown[]) => void): void;
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
      session: unknown;
    };
    on(event: string, listener: (...args: unknown[]) => void): void;
  }

  export const app: {
    getPath(name: string): string;
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    quit(): void;
    setName(name: string): void;
    setLoginItemSettings(settings: { openAtLogin: boolean }): void;
    getVersion(): string;
    requestSingleInstanceLock(): boolean;
    disableHardwareAcceleration(): void;
  };

  export const ipcMain: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    removeHandler(channel: string): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (...args: unknown[]) => void): void;
    removeAllListeners(channel: string): void;
  };

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  };

  export const screen: {
    getPrimaryDisplay(): Display;
    getAllDisplays(): Display[];
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(point: { x: number; y: number }): Display;
    getDisplayMatching(rect: Rectangle): Display;
  };

  export const shell: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<string>;
  };

  export const clipboard: {
    writeText(text: string): void;
    readText(): string;
  };

  export const nativeImage: {
    createFromBuffer(buffer: Buffer, options?: { scaleFactor?: number }): {
      toPNG(): Buffer;
      resize(options: { width?: number; height?: number }): { toPNG(): Buffer; getSize(): { width: number; height: number } };
      isEmpty(): boolean;
    };
  };

  export const desktopCapturer: {
    getSources(options: {
      types: ('screen' | 'window')[];
      thumbnailSize?: { width: number; height: number };
      fetchWindowIcons?: boolean;
    }): Promise<{ id: string; name: string; thumbnail: { toPNG(): Buffer; isEmpty(): boolean } }[]>;
  };

  export const Tray: new (image: unknown) => {
    setToolTip(text: string): void;
    setContextMenu(menu: unknown): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    destroy(): void;
    popUpContextMenu(): void;
  };

  export const Menu: {
    buildFromTemplate(template: unknown[]): unknown;
    setApplicationMenu(menu: unknown): void;
  };

  export const powerMonitor: {
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
}
