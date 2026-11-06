/**
 * Extension service worker.
 *
 * Holds the loopback connection to the desktop app with a shared token the
 * student copies from the app. Policy:
 *  - nothing is forwarded until the student has enabled the bridge AND the
 *    desktop app has sent the list of allowed study sites
 *  - the token is stored in chrome.storage.local, never synced
 *  - reconnect with backoff; drop messages (never queue) while disconnected, so
 *    the extension never becomes an offline spool of browsing data
 *
 * The extension is deliberately site-agnostic: it will read whatever site the
 * app allows. `docs/BROWSER_EXTENSION.md` explains how permission for a site is
 * requested at runtime and why the content script stays inert until then.
 */

const DEFAULT_PORT = 8765;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

let socket = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let allowedSites = [];

async function getConfig() {
  const data = await chrome.storage.local.get(['token', 'port', 'enabled', 'allowedSites']);
  return {
    token: typeof data.token === 'string' ? data.token : '',
    port: typeof data.port === 'number' ? data.port : DEFAULT_PORT,
    enabled: data.enabled === true,
    allowedSites: Array.isArray(data.allowedSites) ? data.allowedSites : [],
  };
}

async function connect() {
  const config = await getConfig();
  allowedSites = config.allowedSites;
  if (!config.enabled || !config.token) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  // Production would use native messaging (no open port at all). A loopback
  // WebSocket bound to 127.0.0.1 is what the app implements today.
  // See docs/BROWSER_EXTENSION.md for the trade-off.
  try {
    socket = new WebSocket(`ws://127.0.0.1:${config.port}`);
    socket.onopen = () => {
      reconnectDelay = RECONNECT_BASE_MS;
      socket.send(JSON.stringify({ type: 'hello', token: config.token, sentAt: new Date().toISOString() }));
      broadcastToTabs({ type: 'set-active', active: true });
    };
    socket.onmessage = (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.type === 'welcome' && Array.isArray(message.payload?.allowedSites)) {
        // The app is authoritative about which sites may be read.
        allowedSites = message.payload.allowedSites;
        void chrome.storage.local.set({ allowedSites });
      }
    };
    socket.onclose = () => {
      socket = null;
      broadcastToTabs({ type: 'set-active', active: false });
      scheduleReconnect();
    };
    socket.onerror = () => {
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
}

async function forward(message) {
  const config = await getConfig();
  if (!config.enabled || !config.token) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    // Connect for next time, but do not buffer this observation.
    void connect();
    return;
  }
  socket.send(JSON.stringify({ ...message, token: config.token, sentAt: new Date().toISOString() }));
}

/** Pushes the "is this site active" flag to every open tab's content script. */
async function broadcastToTabs(message) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        /* no content script in that tab */
      }
    }
  } catch {
    /* tabs permission not granted for that window */
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || typeof message.type !== 'string') return false;
  void forward(message);
  respond({ ok: true });
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  void connect();
});

chrome.storage.onChanged.addListener((changes) => {
  if ('enabled' in changes || 'token' in changes || 'port' in changes || 'allowedSites' in changes) {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
    void connect();
  }
});

void connect();
