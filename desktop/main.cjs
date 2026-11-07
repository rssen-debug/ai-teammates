const { app, BrowserWindow, Menu, session, dialog, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { v5HostOrigin, sameOrigin, restoreV5Bounds } = require('./policy.cjs');

const V5_DISPLAY_VERSION = [5, 0, 0].join('.');
const profileOverride = process.env.MAJIN_V5_DESKTOP_PROFILE || process.env.MAJIN_V4_DESKTOP_PROFILE;
if (profileOverride) {
  app.setPath('userData', path.resolve(profileOverride));
}

let window;
let retry;
let quitting = false;
let connecting = false;
let launchAttempted = false;
let latestPairingCode = null;
let lastHealthyVersion = V5_DISPLAY_VERSION;

const rawUrl = process.env.MAJIN_V5_DESKTOP_URL || process.env.MAJIN_V4_DESKTOP_URL || 'http://127.0.0.1:4555';
const origin = v5HostOrigin(rawUrl);
const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.resolve(__dirname, '..');
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    window?.restore();
    window?.show();
    window?.focus();
  });
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('MAJIN V5', err.message);
    app.quit();
  });
}

async function healthy() {
  try {
    const response = await fetch(`${origin}/api/v5/state`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (response.ok) {
      const body = await response.json();
      if (body && body.ok === true && body.versionInfo && /^5\./.test(String(body.versionInfo.version || ''))) {
        lastHealthyVersion = body.versionInfo.version;
        return true;
      }
    }
  } catch { /* fall through to /api/health */ }

  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) return false;
    const body = await response.json();
    if (body && body.ok === true && (body.app === 'majin-v5' || body.app === 'majin')) {
      if (body.version) lastHealthyVersion = body.version;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function resolveIconPath() {
  if (app.isPackaged) {
    const packagedIcon = path.join(process.resourcesPath, 'icon.png');
    if (fs.existsSync(packagedIcon)) return packagedIcon;
  }
  const majinPng = path.join(hostRoot, 'assets', 'majin.png');
  if (fs.existsSync(majinPng)) return majinPng;
  return path.join(hostRoot, 'src', 'v4', 'ui', 'icons', 'icon-512.png');
}

function startHost() {
  const parsed = new URL(origin);
  if (
    launchAttempted ||
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname)
  ) {
    return;
  }
  if (process.env.MAJIN_V5_DESKTOP_NO_HOST === '1' || process.env.MAJIN_V4_DESKTOP_NO_HOST === '1') {
    return;
  }
  launchAttempted = true;

  const bundledNode = path.join(hostRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const nodeExecutable = app.isPackaged && fs.existsSync(bundledNode) ? bundledNode : 'node';
  const useLegacyV4 = process.env.MAJIN_DESKTOP_RUNTIME === 'v4';
  const hostScript = useLegacyV4
    ? path.join(hostRoot, 'scripts', 'v4', 'desktop-host.mjs')
    : path.join(hostRoot, 'scripts', 'v5', 'desktop-host.mjs');

  const child = spawn(
    nodeExecutable,
    [hostScript, '--port', parsed.port || '4555', '--host', parsed.hostname],
    {
      cwd: hostRoot,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );

  child.on('message', (message) => {
    if (message?.type === 'v5-ready' && message.code) {
      latestPairingCode = String(message.code);
    } else if (message?.type === 'pairing' && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(message.code || '')) {
      latestPairingCode = message.code;
      dialog.showMessageBox(window, {
        type: 'info',
        title: 'Pair MAJIN',
        message: 'Your one-time pairing code',
        detail: `${message.code}\nEnter it in MAJIN on your trusted devices. Keep this code private.`,
      });
    }
  });
  child.on('exit', (code) => {
    if (code !== 0) launchAttempted = false;
  });
  child.on('error', (err) => {
    launchAttempted = false;
    dialog.showErrorBox('MAJIN V5 host', err.message);
  });
  child.unref();
}

async function connect() {
  if (quitting || connecting || window?.isDestroyed()) return;
  connecting = true;
  try {
    if (await healthy()) {
      const currentUrl = window.webContents.getURL();
      if (!currentUrl.startsWith(origin)) {
        await window.loadURL(origin);
      }
      window.setTitle(`MAJIN V5 — GRAND ARCHITECT (${lastHealthyVersion})`);
    } else {
      startHost();
      if (!window.webContents.getURL().startsWith('file:')) {
        await window.loadFile(path.join(__dirname, 'offline.html'));
      }
      clearTimeout(retry);
      retry = setTimeout(connect, 1000);
    }
  } finally {
    connecting = false;
  }
}

async function boot() {
  app.setAppUserModelId('com.majin.v5');
  if (process.argv.includes('--background')) {
    startHost();
    const deadline = Date.now() + 25_000;
    while (!(await healthy()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    app.exit((await healthy()) ? 0 : 1);
    return;
  }

  const partition = session.fromPartition('persist:majin-v5');
  partition.setPermissionCheckHandler((_contents, _permission, _requestOrigin) => false);
  partition.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (
      !sameOrigin(contents.getURL(), origin) ||
      !sameOrigin(details.requestingUrl || '', origin) ||
      details.isMainFrame === false ||
      permission !== 'media' ||
      details.mediaTypes?.some((type) => type !== 'audio')
    ) {
      return callback(false);
    }
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      buttons: ['Allow microphone', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Allow MAJIN V5 to use your microphone for this request?',
    });
    callback(result.response === 0);
  });

  partition.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save MAJIN V5 output' });
  });

  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
  } catch { /* first launch */ }

  window = new BrowserWindow({
    ...restoreV5Bounds(saved, screen.getAllDisplays()),
    minWidth: 420,
    minHeight: 460,
    title: `MAJIN V5 — GRAND ARCHITECT (${V5_DISPLAY_VERSION})`,
    backgroundColor: '#07080a',
    icon: resolveIconPath(),
    webPreferences: {
      partition: 'persist:majin-v5',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  if (saved?.maximized) window.maximize();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, origin)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!sameOrigin(url, origin)) event.preventDefault();
  });
  window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) {
      clearTimeout(retry);
      retry = setTimeout(connect, 1000);
    }
  });
  window.on('close', () => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const temp = `${boundsFile()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
    fs.renameSync(temp, boundsFile());
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'MAJIN V5',
        submenu: [
          { label: 'Reconnect to local V5 host', click: connect },
          {
            label: 'Show mobile pairing code',
            click: () => {
              dialog.showMessageBox(window, {
                type: 'info',
                title: 'Pair mobile device with MAJIN V5',
                message: latestPairingCode ? `Pairing code: ${latestPairingCode}` : 'Local V5 host connected',
                detail: latestPairingCode
                  ? `Enter code ${latestPairingCode} on your phone to pair with ${origin}.`
                  : `Host URL: ${origin}`,
              });
            },
          },
          {
            label: 'Start host when I log in',
            type: 'checkbox',
            enabled: app.isPackaged,
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--background'] }),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );

  await connect();
}

app.on('before-quit', () => {
  quitting = true;
  clearTimeout(retry);
});
app.on('window-all-closed', () => app.quit());
