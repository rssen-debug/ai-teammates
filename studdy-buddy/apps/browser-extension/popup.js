const enabled = document.getElementById('enabled');
const token = document.getElementById('token');
const port = document.getElementById('port');
const status = document.getElementById('status');
const save = document.getElementById('save');
const sitesEl = document.getElementById('sites');
const allowCurrent = document.getElementById('allow-current');

async function load() {
  const data = await chrome.storage.local.get(['token', 'port', 'enabled', 'allowedSites']);
  enabled.checked = data.enabled === true;
  token.value = typeof data.token === 'string' ? data.token : '';
  port.value = typeof data.port === 'number' ? data.port : 8765;
  renderSites(Array.isArray(data.allowedSites) ? data.allowedSites : []);
  updateStatus();
}

/** Sends one message through the service worker. Resolves false when offline. */
function sendToApp(message) {
  return new Promise((resolve) => {
    try {
      const socketless = chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(Boolean(response?.ok));
      });
      void socketless;
    } catch {
      resolve(false);
    }
  });
}

function renderSites(sites) {
  if (!sites.length) {
    sitesEl.textContent = 'Inga sajter tillåtna ännu. Lägg till dem i appens inställningar.';
    return;
  }
  sitesEl.textContent = sites.join(', ');
}

/**
 * Asking the app to allow the current site is a deliberate two-step:
 *  1. the student presses this button and Chrome asks for permission on the host
 *  2. the request is sent to the app, which owns the authoritative allow-list
 * The extension never decides on its own that a site may be read.
 */
allowCurrent.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    sitesEl.textContent = 'Kunde inte läsa flikens adress.';
    return;
  }
  let host;
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    sitesEl.textContent = 'Ogiltig adress.';
    return;
  }
  try {
    if (chrome.permissions?.request) {
      await chrome.permissions.request({ origins: [`https://${host}/*`] });
    }
  } catch {
    /* the student declined; the app request below still applies */
  }
  const data = await chrome.storage.local.get(['allowedSites']);
  const sites = Array.isArray(data.allowedSites) ? data.allowedSites : [];
  if (!sites.includes(host)) sites.push(host);
  await chrome.storage.local.set({ allowedSites: sites });
  renderSites(sites);
  // The app is authoritative: we ask it, and it decides. Until it confirms, the
  // content script stays inert even though Chrome's host permission exists.
  const sent = await sendToApp({ type: 'site-request', payload: { host } });
  sitesEl.textContent = sent
    ? `${sites.join(', ')} – begäran skickad till appen. Godkänn den i Studdy Buddy.`
    : `${sites.join(', ')} – appen är inte ansluten. Öppna Studdy Buddy och försök igen.`;
});

function updateStatus() {
  if (!enabled.checked) {
    status.textContent = 'Avstängd. Inget läses eller skickas.';
    status.className = 'status';
    return;
  }
  if (!token.value.trim()) {
    status.textContent = 'Token saknas. Kopiera den från appens inställningar.';
    status.className = 'status warn';
    return;
  }
  status.textContent = 'Aktiv. Kopplar upp mot appen på 127.0.0.1.';
  status.className = 'status ok';
}

save.addEventListener('click', async () => {
  await chrome.storage.local.set({
    enabled: enabled.checked,
    token: token.value.trim(),
    port: Number(port.value) || 8765,
  });
  updateStatus();
});

enabled.addEventListener('change', updateStatus);
token.addEventListener('input', updateStatus);

void load();
