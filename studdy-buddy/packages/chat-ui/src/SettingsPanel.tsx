import { useState } from 'react';
import type { ModelCapabilities, PermissionKey, PermissionMode, ProviderConfig, Settings } from '@studdy/shared';
import { darkTheme, themeToCssVars, type Theme } from './theme.js';

/**
 * Settings surface: provider, permissions, voice, data.
 *
 * Deliberately NOT a permanent dashboard - it is a stacked panel shown on
 * demand. Every capability shown here comes from a real probe or a real stored
 * value; nothing is displayed as "supported" because a model name sounds modern.
 */

export interface SettingsPanelProps {
  settings: Settings;
  provider: ProviderConfig | null;
  capabilities: ModelCapabilities | null;
  permissions: { key: PermissionKey; granted: boolean }[];
  usage: { requests: number; estimatedCostUsd: number; limitUsd: number } | null;
  onSaveProvider: (patch: Partial<ProviderConfig> & { apiKey?: string }) => Promise<{ ok: boolean; message: string }>;
  onTestProvider: () => Promise<{ ok: boolean; message: string }>;
  onProbeCapabilities: () => Promise<{ ok: boolean; message: string }>;
  onPermission: (key: PermissionKey, granted: boolean) => void;
  onModeChange: (mode: PermissionMode) => void;
  onSettingsChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  onResetLearningData: () => void;
  /** Browser bridge: which sites may be read, and the token the extension needs. */
  bridge?: BridgePanelState;
  onAddSite?: (site: string) => Promise<void>;
  onRemoveSite?: (site: string) => Promise<void>;
  onRotateBridgeToken?: () => Promise<void>;
  githubDebug?: { repository: string; enabled: boolean; hasToken: boolean; target: string } | null;
  onGitHubConfigure?: (config: { repository: string; token?: string; enabled: boolean }) => Promise<{ ok: boolean; message: string }>;
  onGitHubSyncNow?: () => Promise<{ ok: boolean; message: string }>;
  theme?: Theme;
}

export interface BridgePanelState {
  running: boolean;
  port: number | null;
  clients: number;
  detail: string;
  allowedSites: string[];
  pendingSites: string[];
  token: string;
  observation: { url: string | null; title: string | null; nodeCount: number } | null;
}

const PERMISSION_LABELS: Record<PermissionKey, { title: string; detail: string }> = {
  'screen.capture': { title: 'Skärmbild', detail: 'Fånga ett valt fönster när du ber om hjälp med det som syns.' },
  'application.observe': { title: 'Läsa programfönster', detail: 'Läsa fönstertitlar och tillgänglighetsinformation från godkända program.' },
  'browser.read': { title: 'Läsa studiesidan', detail: 'Läsa sidan på de sajter du tillåter, och text du markerar.' },
  microphone: { title: 'Mikrofon', detail: 'Endast när du startar röstinmatning själv.' },
  'computer.actions': { title: 'Utföra klick', detail: 'Kräver att du godkänner varje enskild handling.' },
  'provider.dataShare': { title: 'Skicka kontext till AI', detail: 'Skicka den kontext du ser i samtalet till den valda AI-providern.' },
};

const MODES: { id: PermissionMode; title: string; detail: string }[] = [
  { id: 'OBSERVE_ONLY', title: 'Bara observera', detail: 'Buddy får läsa godkänd kontext men inte rita eller klicka.' },
  { id: 'VISUAL_GUIDE', title: 'Visuell guide', detail: 'Buddy får markera saker på skärmen och förklara.' },
  { id: 'APPROVED_ACTION', title: 'Godkända handlingar', detail: 'Buddy får utföra en handling i taget efter din bekräftelse.' },
];

export function SettingsPanel(props: SettingsPanelProps) {
  const theme = props.theme ?? darkTheme;
  const [tab, setTab] = useState<'provider' | 'bridge' | 'permissions' | 'voice' | 'data'>('provider');
  const [form, setForm] = useState({
    name: props.provider?.name ?? 'DeepSeek',
    baseUrl: props.provider?.baseUrl ?? 'https://api.deepseek.com/v1',
    modelId: props.provider?.modelId ?? 'deepseek-flash',
    visionModelId: props.provider?.visionModelId ?? '',
    fallbackModelId: props.provider?.fallbackModelId ?? '',
    apiKey: '',
    dailyCostLimitUsd: props.provider?.dailyCostLimitUsd ?? 2,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [siteInput, setSiteInput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(key);
    setStatus(null);
    try {
      setStatus(await fn());
    } finally {
      setBusy(null);
    }
  };

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [quickProvider, setQuickProvider] = useState<'kilo' | 'deepseek'>(
    props.provider?.baseUrl?.includes('kilo.ai') ? 'kilo' : props.provider?.baseUrl?.includes('deepseek.com') ? 'deepseek' : 'kilo',
  );
  const [quickKey, setQuickKey] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickStatus, setQuickStatus] = useState<string | null>(null);
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubRepo, setGithubRepo] = useState(props.githubDebug?.repository || 'rssen-debug/ai-teammates');
  const [githubToken, setGithubToken] = useState('');
  const [githubEnabled, setGithubEnabled] = useState(props.githubDebug?.enabled ?? false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubFeedback, setGithubFeedback] = useState<string | null>(null);

  const configureGitHub = async () => {
    if (!props.onGitHubConfigure || githubBusy) return;
    setGithubBusy(true);
    try {
      const result = await props.onGitHubConfigure({ repository: githubRepo.trim(),
        ...(githubToken.trim() ? { token: githubToken.trim() } : {}),
        enabled: githubEnabled });
      setGithubFeedback(result.message);
      if (result.ok) setGithubToken('');
    } finally { setGithubBusy(false); }
  };
  const syncGitHub = async () => {
    if (!props.onGitHubSyncNow || githubBusy) return;
    setGithubBusy(true);
    try { const result = await props.onGitHubSyncNow(); setGithubFeedback(result.message); }
    finally { setGithubBusy(false); }
  };

  const saveQuick = async () => {
    if (quickBusy || !quickKey.trim()) return;
    setQuickBusy(true);
    setQuickStatus(null);
    try {
      const result = await props.onSaveProvider({
        name: quickProvider === 'kilo' ? 'Kilo Code' : 'DeepSeek',
        baseUrl: quickProvider === 'kilo' ? 'https://ai-gateway.kilo.ai/api/v1' : 'https://api.deepseek.com/v1',
        modelId: quickProvider === 'kilo' ? 'kilo-auto/free' : 'deepseek-flash',
        // Try the same automatic route for on-demand screenshots. A real
        // provider response determines whether this route supports vision;
        // no screen is sent until the student asks and sharing is permitted.
        visionModelId: quickProvider === 'kilo' ? 'kilo-auto/free' : 'deepseek-flash',
        fallbackModelId: null,
        apiKey: quickKey.trim(),
        dailyCostLimitUsd: 2,
      });
      if (!result.ok) {
        setQuickStatus(result.message);
        return;
      }
      // Scoped study permissions are persisted; capture still needs an
      // approved study window and the browser extension still needs its
      // own browser permissions. Never enable unattended desktop clicks.
      for (const key of ['screen.capture', 'application.observe', 'browser.read', 'provider.dataShare'] as PermissionKey[]) {
        props.onPermission(key, true);
      }
      props.onModeChange('VISUAL_GUIDE');
      setQuickKey('');
      setQuickStatus('Sparat! Buddy är redo för textfrågor. Välj ett studiefönster för skärmhjälp.');
    } catch (error) {
      setQuickStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setQuickBusy(false);
    }
  };

  if (!advancedOpen) {
    return (
      <div style={themeToCssVars(theme) as React.CSSProperties} className="buddy-settings" role="dialog" aria-label="Enkel inställning">
        <style>{settingsCss}</style>
        <header>
          <h2>Buddy</h2>
          <button type="button" className="buddy-s-btn" onClick={props.onClose} aria-label="Stäng inställningar">✕</button>
        </header>
        <section className="buddy-s-section" style={{ paddingTop: 16 }}>
          <h3>{props.provider?.hasApiKey ? 'AI är ansluten' : 'Anslut din AI'}</h3>
          <p className="buddy-s-hint">En gång: välj leverantör, klistra in nyckeln och spara. Buddy kommer ihåg den lokalt.</p>
          <label>
            AI-leverantör
            <select value={quickProvider} onChange={(event) => setQuickProvider(event.target.value as 'kilo' | 'deepseek')}>
              <option value="kilo">Kilo Code (gratis om modellen är tillgänglig)</option>
              <option value="deepseek">DeepSeek API</option>
            </select>
          </label>
          <label>
            API-nyckel
            <input type="password" value={quickKey}
              onChange={(event) => setQuickKey(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void saveQuick(); }}
              onBlur={() => { if (quickKey.trim()) void saveQuick(); }}
              autoComplete="off"
              placeholder={props.provider?.hasApiKey ? 'Sparad – ange ny för att byta' : 'Klistra in API-nyckel'}
            />
          </label>
          <div className="buddy-s-actions">
            <button type="button" className="buddy-s-btn is-primary" disabled={quickBusy || !quickKey.trim()}
              onClick={() => void saveQuick()}>{quickBusy ? 'Sparar…' : 'Spara och börja'}</button>
            <button type="button" className="buddy-s-btn" onClick={() => setAdvancedOpen(true)}>Avancerat</button>
          </div>
          {quickStatus && <p className="buddy-s-hint" role="status">{quickStatus}</p>}
          {props.provider?.hasApiKey && <p className="buddy-s-hint">En nyckel finns redan sparad. Den följer med vid uppdateringar.</p>}
          <p className="buddy-s-hint">När du sparar godkänner du att Buddy läser valt studiefönster och skickar relevant innehåll till AI-providern när du ställer en skärmfråga. Kilo Auto Free kan behandla indata hos underleverantörer. Mikrofon och datorklick kräver separat aktivering eller bekräftelse.</p>
        </section>
      </div>
    );
  }

  return (
    <div style={themeToCssVars(theme) as React.CSSProperties} className="buddy-settings" role="dialog" aria-label="Inställningar">
      <style>{settingsCss}</style>
      <header>
        <h2>Inställningar</h2>
        <button type="button" className="buddy-s-btn" onClick={props.onClose} aria-label="Stäng inställningar">
          ✕
        </button>
      </header>

      <nav className="buddy-s-tabs" role="tablist">
        {(['provider', 'bridge', 'permissions', 'voice', 'data'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`buddy-s-tab ${tab === t ? 'is-active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'provider'
              ? 'AI-provider'
              : t === 'bridge'
                ? 'Webbläsare'
                : t === 'permissions'
                  ? 'Behörigheter'
                  : t === 'voice'
                    ? 'Röst'
                    : 'Data'}
          </button>
        ))}
      </nav>

      {status && <div className={`buddy-s-status ${status.ok ? 'is-ok' : 'is-error'}`}>{status.message}</div>}

      {tab === 'provider' && (
        <section className="buddy-s-section">
          <p className="buddy-s-hint">
            Ange endpoint och modell-id själv. Buddy testar vad endpointen faktiskt klarar innan något används.
          </p>

          <label>
            Namn
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Base URL
            <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
          </label>
          <label>
            Modell-id
            <input value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} placeholder="deepseek-flash" />
          </label>
          <label>
            API-nyckel {props.provider ? '(lämna tom för att behålla nuvarande)' : ''}
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={props.provider ? '••••••••' : ''}
              autoComplete="off"
            />
          </label>
          <div className="buddy-s-row">
            <label>
              Vision-modell-id
              <input value={form.visionModelId} onChange={(e) => setForm({ ...form, visionModelId: e.target.value })} placeholder="valfritt" />
            </label>
            <label>
              Reservmodell
              <input value={form.fallbackModelId} onChange={(e) => setForm({ ...form, fallbackModelId: e.target.value })} placeholder="valfritt" />
            </label>
          </div>
          <label>
            Dagsbudget (USD)
            <input
              type="number"
              min={0}
              step={0.5}
              value={form.dailyCostLimitUsd}
              onChange={(e) => setForm({ ...form, dailyCostLimitUsd: Number(e.target.value) })}
            />
          </label>

          <div className="buddy-s-actions">
            <button
              type="button"
              className="buddy-s-btn is-primary"
              disabled={busy !== null}
              onClick={() =>
                run('save', () =>
                  props.onSaveProvider({
                    name: form.name,
                    baseUrl: form.baseUrl,
                    modelId: form.modelId,
                    visionModelId: form.visionModelId || null,
                    fallbackModelId: form.fallbackModelId || null,
                    dailyCostLimitUsd: form.dailyCostLimitUsd,
                    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
                  }),
                )
              }
            >
              {busy === 'save' ? 'Sparar…' : 'Spara'}
            </button>
            <button type="button" className="buddy-s-btn" disabled={busy !== null} onClick={() => run('test', props.onTestProvider)}>
              {busy === 'test' ? 'Testar…' : 'Testa anslutning'}
            </button>
            <button type="button" className="buddy-s-btn" disabled={busy !== null} onClick={() => run('probe', props.onProbeCapabilities)}>
              {busy === 'probe' ? 'Testar…' : 'Testa funktioner'}
            </button>
          </div>

          <div className="buddy-s-caps">
            <h3>Verifierade funktioner</h3>
            {props.capabilities ? (
              <ul>
                <CapRow label="Text" ok={props.capabilities.text} />
                <CapRow label="Streaming" ok={props.capabilities.streaming} />
                <CapRow label="JSON-utdata" ok={props.capabilities.json} />
                <CapRow label="Vision" ok={props.capabilities.vision} />
                <CapRow label="Tool calling" ok={props.capabilities.tools} />
              </ul>
            ) : (
              <p className="buddy-s-hint">Ingen mätning gjord ännu. Kör "Testa funktioner".</p>
            )}
            {props.usage && (
              <p className="buddy-s-hint">
                Idag: {props.usage.requests} anrop, {props.usage.estimatedCostUsd.toFixed(3)} USD av {props.usage.limitUsd} USD.
              </p>
            )}
          </div>
        </section>
      )}

      {tab === 'bridge' && (
        <section className="buddy-s-section">
          <h3>Var pluggar du?</h3>
          <p className="buddy-s-hint">
            Buddy läser den studiesida du har öppen – Canvas, NetAcad, Moodle, Itslearning eller vilken sajt som helst.
            Ingenting läses förrän du lägger till sajten här.
          </p>

          {props.bridge ? (
            <>
              <p className={`buddy-s-hint ${props.bridge.running ? 'is-ok' : 'is-error'}`}>
                {props.bridge.running
                  ? `Ansluten lyssnare på 127.0.0.1:${props.bridge.port} · ${props.bridge.clients} ansluten förlängning.`
                  : props.bridge.detail}
              </p>

              <h3>Tillåtna sajter</h3>
              {props.bridge.allowedSites.length === 0 ? (
                <p className="buddy-s-hint">Inga sajter tillåtna ännu. Lägg till den sajt du studerar på.</p>
              ) : (
                <ul className="buddy-s-perms">
                  {props.bridge.allowedSites.map((site) => (
                    <li key={site}>
                      <div>
                        <strong>{site}</strong>
                        <span>Läses bara när du har tillägget påslaget.</span>
                      </div>
                      <button
                        type="button"
                        className="buddy-s-btn"
                        onClick={() => void props.onRemoveSite?.(site)}
                        aria-label={`Ta bort ${site}`}
                      >
                        Ta bort
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {props.bridge.pendingSites.length > 0 && (
                <div className="buddy-s-pending">
                  <h3>Förfrågningar från tillägget</h3>
                  <ul>
                    {props.bridge.pendingSites.map((site) => (
                      <li key={site}>
                        <span>{site}</span>
                        <button type="button" className="buddy-s-btn is-primary" onClick={() => void props.onAddSite?.(site)}>
                          Tillåt
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="buddy-s-row">
                <label>
                  Lägg till sajt
                  <input
                    value={siteInput}
                    onChange={(e) => setSiteInput(e.target.value)}
                    placeholder="canvas.instructure.com"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  className="buddy-s-btn is-primary"
                  disabled={!siteInput.trim()}
                  onClick={async () => {
                    await props.onAddSite?.(siteInput.trim());
                    setSiteInput('');
                  }}
                >
                  Lägg till
                </button>
              </div>

              <h3>Koppla tillägget</h3>
              <p className="buddy-s-hint">
                Klistra in den här nyckeln i tilläggets popup. Den gäller bara på den här datorn.
              </p>
              <code className="buddy-s-token" aria-label="Bryggtoken">
                {props.bridge.token}
              </code>
              <div className="buddy-s-actions">
                <button type="button" className="buddy-s-btn" onClick={() => void props.onRotateBridgeToken?.()}>
                  Ny nyckel (kopplar från tillägget)
                </button>
              </div>

              <p className="buddy-s-hint">
                {props.bridge.observation
                  ? `Läser nu: ${props.bridge.observation.title ?? props.bridge.observation.url} (${props.bridge.observation.nodeCount} noder i kursen).`
                  : 'Ingen sida läst ännu.'}
              </p>
            </>
          ) : (
            <p className="buddy-s-hint">Bryggan är inte tillgänglig i den här versionen.</p>
          )}
        </section>
      )}

      {tab === 'permissions' && (
        <section className="buddy-s-section">
          <h3>Läge</h3>
          <div className="buddy-s-modes">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`buddy-s-mode ${props.settings.permissionMode === m.id ? 'is-active' : ''}`}
                onClick={() => props.onModeChange(m.id)}
                aria-pressed={props.settings.permissionMode === m.id}
              >
                <strong>{m.title}</strong>
                <span>{m.detail}</span>
              </button>
            ))}
          </div>

          <h3>Behörigheter</h3>
          <ul className="buddy-s-perms">
            {props.permissions.map((perm) => {
              const meta = PERMISSION_LABELS[perm.key];
              return (
                <li key={perm.key}>
                  <div>
                    <strong>{meta.title}</strong>
                    <span>{meta.detail}</span>
                  </div>
                  <label className="buddy-s-switch">
                    <input
                      type="checkbox"
                      checked={perm.granted}
                      onChange={(e) => props.onPermission(perm.key, e.target.checked)}
                      aria-label={meta.title}
                    />
                    <span />
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="buddy-s-hint">Allt är avstängt från början. Du kan återkalla en behörighet när som helst.</p>
        </section>
      )}

      {tab === 'voice' && (
        <section className="buddy-s-section">
          <label className="buddy-s-check">
            <input
              type="checkbox"
              checked={props.settings.voice.enabled}
              onChange={(e) => props.onSettingsChange({ voice: { ...props.settings.voice, enabled: e.target.checked } })}
            />
            Slå på röst (avstängt som standard)
          </label>
          <label>
            Provider
            <select
              value={props.settings.voice.provider}
              onChange={(e) =>
                props.onSettingsChange({
                  voice: { ...props.settings.voice, provider: e.target.value as Settings['voice']['provider'] },
                })
              }
            >
              <option value="none">Ingen</option>
              <option value="windows-native">Windows-röster (offline)</option>
              <option value="openai-compatible">OpenAI-kompatibel</option>
              <option value="elevenlabs">ElevenLabs</option>
            </select>
          </label>
          <label>
            Språk
            <select
              value={props.settings.voice.language}
              onChange={(e) =>
                props.onSettingsChange({ voice: { ...props.settings.voice, language: e.target.value as 'sv-SE' | 'en-US' } })
              }
            >
              <option value="sv-SE">Svenska</option>
              <option value="en-US">Engelska</option>
            </select>
          </label>
          <label>
            Hastighet ({props.settings.voice.speed.toFixed(1)}×)
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={props.settings.voice.speed}
              onChange={(e) => props.onSettingsChange({ voice: { ...props.settings.voice, speed: Number(e.target.value) } })}
            />
          </label>
          <label>
            Volym ({Math.round(props.settings.voice.volume * 100)} %)
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={props.settings.voice.volume}
              onChange={(e) => props.onSettingsChange({ voice: { ...props.settings.voice, volume: Number(e.target.value) } })}
            />
          </label>
          <p className="buddy-s-hint">Röst används bara när du klickar "Läs upp" eller startar röstläge.</p>
        </section>
      )}

      {props.onGitHubConfigure && (
        <section className="buddy-s-section" style={{ borderTop: '1px solid var(--buddy-border)' }}>
          <button type="button" className="buddy-s-btn" onClick={() => setGithubOpen(open => !open)}
            aria-expanded={githubOpen}>
            {githubOpen ? 'Dölj GitHub-felsynk' : 'GitHub-felsynk (valfritt)'}
          </button>
          {githubOpen && (
            <>
              <p className="buddy-s-hint">
                GitHub får endast en rensad rapport med felkoder. Den privata debugger.md,
                skärmbilder, AI-nycklar och chattar laddas aldrig upp.
              </p>
              <label>Repository (owner/repo)
                <input value={githubRepo} onChange={event => setGithubRepo(event.target.value)}
                  placeholder="rssen-debug/ai-teammates"/>
              </label>
              <label>GitHub PAT (begränsa till Contents: read/write i endast detta repo)
                <input type="password" autoComplete="off" value={githubToken}
                  onChange={event => setGithubToken(event.target.value)}
                  placeholder={props.githubDebug?.hasToken ? 'Nyckel sparad – lämna tom för att behålla' : 'Klistra in privat här, inte i chatten'}/>
              </label>
              <label className="buddy-s-check">
                <input type="checkbox" checked={githubEnabled} onChange={event => setGithubEnabled(event.target.checked)}/>
                Synka rensade felkoder automatiskt var 30:e minut
              </label>
              <div className="buddy-s-actions">
                <button type="button" className="buddy-s-btn is-primary" disabled={githubBusy}
                  onClick={() => void configureGitHub()}>Spara GitHub</button>
                <button type="button" className="buddy-s-btn" disabled={githubBusy || !props.githubDebug?.enabled}
                  onClick={() => void syncGitHub()}>Synka nu</button>
              </div>
              {githubFeedback && <p role="status" className="buddy-s-hint">{githubFeedback}</p>}
            </>
          )}
        </section>
      )}

      {tab === 'data' && (
        <section className="buddy-s-section">
          <label className="buddy-s-check">
            <input
              type="checkbox"
              checked={props.settings.reducedMotion}
              onChange={(e) => props.onSettingsChange({ reducedMotion: e.target.checked })}
            />
            Minska rörelse
          </label>
          <label>
            Proaktiva tips
            <select
              value={props.settings.proactive}
              onChange={(e) => props.onSettingsChange({ proactive: e.target.value as Settings['proactive'] })}
            >
              <option value="OFF">Av</option>
              <option value="QUIET">Tysta</option>
              <option value="NORMAL">Normala</option>
            </select>
          </label>
          <button type="button" className="buddy-s-btn is-danger" onClick={props.onResetLearningData}>
            Radera inlärningshistorik
          </button>
          <p className="buddy-s-hint">
            Historiken ligger lokalt i en SQLite-databas. Skärmbilder sparas inte som standard.
          </p>
        </section>
      )}
    </div>
  );
}

function CapRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li>
      <span className={ok ? 'buddy-cap-ok' : 'buddy-cap-no'} aria-hidden="true">
        {ok ? '✓' : '✕'}
      </span>
      {label}
      <span className="buddy-cap-note">{ok ? 'verifierad' : 'ej verifierad'}</span>
    </li>
  );
}

const settingsCss = `
  .buddy-s-token {
    display: block;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    word-break: break-all;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    padding: 8px;
    margin-bottom: 10px;
    user-select: all;
  }
  .buddy-s-pending ul { list-style: none; padding: 0; margin: 0 0 12px; }
  .buddy-s-pending li {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-size: 12px; padding: 6px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .buddy-s-hint.is-ok { color: #8fcbae; }
  .buddy-s-hint.is-error { color: #f08a7a; }

.buddy-settings {
  font-family: var(--buddy-font-ui); color: var(--buddy-text); background: var(--buddy-surface);
  border:1px solid var(--buddy-border); border-radius: var(--buddy-radius-lg); box-shadow: var(--buddy-shadow);
  width: 100%; max-width: 420px; max-height: 600px; overflow-y:auto; backdrop-filter: blur(18px);
}
.buddy-settings header { display:flex; align-items:center; justify-content:space-between; padding: 14px 16px 8px; }
.buddy-settings h2 { margin:0; font-size: 14px; font-weight: 600; }
.buddy-settings h3 { margin: 16px 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--buddy-text-faint); }
.buddy-s-tabs { display:flex; gap:4px; padding: 0 16px 10px; border-bottom: 1px solid var(--buddy-border); }
.buddy-s-tab {
  background:none; border:none; color: var(--buddy-text-faint); font-size: 12px; padding: 4px 8px;
  border-radius: var(--buddy-radius-pill); cursor:pointer;
}
.buddy-s-tab.is-active { background: var(--buddy-accent-soft); color: var(--buddy-accent); }
.buddy-s-section { padding: 14px 16px 18px; display:flex; flex-direction:column; gap: 12px; }
.buddy-s-section label { display:flex; flex-direction:column; gap:5px; font-size: 11.5px; color: var(--buddy-text-muted); }
.buddy-s-section input[type=text], .buddy-s-section input[type=password], .buddy-s-section input[type=number],
.buddy-s-section input:not([type]), .buddy-s-section select {
  background: var(--buddy-surface-sunken); border: 1px solid var(--buddy-border); color: var(--buddy-text);
  border-radius: var(--buddy-radius-sm); padding: 7px 9px; font-size: 12.5px; font-family: var(--buddy-font-ui);
}
.buddy-s-section input:focus, .buddy-s-section select:focus { outline: 2px solid var(--buddy-accent); outline-offset: 1px; }
.buddy-s-row { display:flex; gap:10px; }
.buddy-s-row label { flex:1; }
.buddy-s-hint { font-size: 11.5px; color: var(--buddy-text-faint); line-height: 1.45; margin: 0; }
.buddy-s-actions { display:flex; gap:8px; flex-wrap: wrap; margin-top: 4px; }
.buddy-s-btn {
  background: var(--buddy-surface-sunken); border:1px solid var(--buddy-border); color: var(--buddy-text);
  border-radius: var(--buddy-radius-pill); padding: 6px 14px; font-size: 12px; cursor:pointer;
}
.buddy-s-btn.is-primary { background: var(--buddy-accent); color: var(--buddy-accent-text); border-color: transparent; font-weight: 600; }
.buddy-s-btn.is-danger { color: var(--buddy-danger); border-color: var(--buddy-danger); background: transparent; }
.buddy-s-btn:disabled { opacity: 0.5; cursor: default; }
.buddy-s-status { margin: 10px 16px 0; padding: 8px 10px; border-radius: var(--buddy-radius-sm); font-size: 12px; line-height:1.4; }
.buddy-s-status.is-ok { background: var(--buddy-accent-soft); color: var(--buddy-accent); }
.buddy-s-status.is-error { background: var(--buddy-danger-soft); color: var(--buddy-danger); }
.buddy-s-caps ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:5px; font-size: 12px; }
.buddy-s-caps li { display:flex; align-items:center; gap:8px; }
.buddy-cap-ok { color: var(--buddy-success); }
.buddy-cap-no { color: var(--buddy-text-faint); }
.buddy-cap-note { margin-left:auto; font-size: 10.5px; color: var(--buddy-text-faint); }
.buddy-s-modes { display:flex; flex-direction:column; gap:8px; }
.buddy-s-mode {
  text-align:left; display:flex; flex-direction:column; gap:3px; padding: 10px 12px; cursor:pointer;
  background: var(--buddy-surface-sunken); border:1px solid var(--buddy-border); border-radius: var(--buddy-radius-md);
  color: var(--buddy-text);
}
.buddy-s-mode.is-active { border-color: var(--buddy-accent); background: var(--buddy-accent-soft); }
.buddy-s-mode strong { font-size: 12.5px; font-weight: 600; }
.buddy-s-mode span { font-size: 11.5px; color: var(--buddy-text-faint); line-height:1.4; }
.buddy-s-perms { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
.buddy-s-perms li { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.buddy-s-perms li div { display:flex; flex-direction:column; gap:2px; }
.buddy-s-perms strong { font-size: 12.5px; font-weight: 600; }
.buddy-s-perms span { font-size: 11px; color: var(--buddy-text-faint); line-height:1.4; }
.buddy-s-switch { position:relative; display:inline-block; width: 36px; height: 20px; flex: 0 0 auto; }
.buddy-s-switch input { opacity: 0; width:0; height:0; }
.buddy-s-switch span { position:absolute; inset:0; background: var(--buddy-surface-sunken); border:1px solid var(--buddy-border-strong); border-radius: 999px; transition: background 140ms ease; }
.buddy-s-switch span::after {
  content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%;
  background: var(--buddy-text-faint); transition: transform 140ms ease, background 140ms ease;
}
.buddy-s-switch input:checked + span { background: var(--buddy-accent-soft); border-color: var(--buddy-accent); }
.buddy-s-switch input:checked + span::after { transform: translateX(16px); background: var(--buddy-accent); }
.buddy-s-switch input:focus-visible + span { outline: 2px solid var(--buddy-accent); outline-offset: 2px; }
.buddy-s-check { flex-direction: row !important; align-items:center; gap:8px !important; font-size: 12.5px !important; color: var(--buddy-text) !important; }
`;
