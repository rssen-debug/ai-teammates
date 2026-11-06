import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ModelCapabilities, PermissionKey, PermissionMode, ProviderConfig, ResponseMode, Settings } from '@studdy/shared';
import { createId, DEFAULT_SETTINGS } from '@studdy/shared';
import { Buddy, type MascotSignal } from '@studdy/mascot';
import { ChatBubble, ProgressPanel, SettingsPanel, themeFor, type BridgePanelState } from '@studdy/chat-ui';
import type { ReadinessScore } from '@studdy/learning-engine';
import { getBridge } from './bridge.js';

/**
 * The mascot window's renderer.
 *
 * Layout: the monkey sits in the top-left of a transparent window; the bubble
 * occupies the space to its right and below. Making the bubble part of the same
 * DOM (rather than a separate OS window) is what prevents focus stealing and
 * z-order fights with Packet Tracer, which is the usual failure mode for
 * desktop assistants.
 *
 * Click-through: the transparent regions report to the main process so that
 * clicks land on the application underneath. The mascot and bubble stay solid.
 */

type View = 'chat' | 'settings' | 'progress';

export function App() {
  const bridge = useMemo(() => getBridge(), []);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  // Never read directly (the settings panel gets it from the diagnostics probe),
  // but kept so capability results survive a re-render of the panel.
  const [, setCapabilities] = useState<ModelCapabilities | null>(null);
  const [usage, setUsage] = useState<{ requests: number; estimatedCostUsd: number; limitUsd: number } | null>(null);
  const [permissions, setPermissions] = useState<{ key: PermissionKey; granted: boolean }[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mode, setMode] = useState<ResponseMode>('NORMAL');
  const [streaming, setStreaming] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('chat');
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [signal, setSignal] = useState<MascotSignal>('app-idle');
  const [greeting, setGreeting] = useState<string | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [bridgeState, setBridgeState] = useState<BridgePanelState | null>(null);
  const [captureSources, setCaptureSources] = useState<{ id: string; name: string }[]>([]);
  const [captureSourceId, setCaptureSourceId] = useState('');
  const [readiness, setReadiness] = useState<ReadinessScore | null>(null);
  const [courseInfo, setCourseInfo] = useState<{ name: string; moduleCount: number } | null>(null);
  const [platformProgress, setPlatformProgress] = useState<{ completed: number; total: number } | null>(null);
  const [position, setPosition] = useState<string[] | null>(null);
  const [systemDark, setSystemDark] = useState(true);
  const inactivity = useRef<ReturnType<typeof setTimeout> | null>(null);
  const theme = themeFor(settings.theme, systemDark);

  // ---- browser bridge ----------------------------------------------------
  const refreshBridge = useCallback(async () => {
    if (!bridge) return;
    const result = await bridge.bridge.status();
    if (result.ok) setBridgeState(result.data);
  }, [bridge]);

  /**
   * Pulls the readiness score and the course facts it is measured against.
   * The panel is never given a number without these.
   */
  const refreshProgress = useCallback(async () => {
    if (!bridge) return;
    const [snapshot, graphResult] = await Promise.all([bridge.learning.snapshot(), bridge.bridge.pageGraph()]);
    if (snapshot.ok) {
      const data = snapshot.data as {
        readiness?: ReadinessScore;
        course?: { name: string; moduleCount: number } | null;
      };
      if (data.readiness) setReadiness(data.readiness);
      if (data.course) setCourseInfo(data.course);
    }
    if (graphResult.ok && graphResult.data) {
      const graph = graphResult.data as { nodes?: { kind: string; title: string; platformCompleted?: boolean | null }[] };
      const nodes = graph.nodes ?? [];
      const withFlag = nodes.filter((n) => n.platformCompleted !== undefined && n.platformCompleted !== null);
      if (withFlag.length) {
        setPlatformProgress({ completed: withFlag.filter((n) => n.platformCompleted === true).length, total: withFlag.length });
      }
    }
  }, [bridge]);

  const addSite = async (site: string) => {
    if (!bridge) return;
    await bridge.bridge.addSite(site);
    await refreshBridge();
  };
  const removeSite = async (site: string) => {
    if (!bridge) return;
    await bridge.bridge.removeSite(site);
    await refreshBridge();
  };
  const rotateBridgeToken = async () => {
    if (!bridge) return;
    await bridge.bridge.rotateToken();
    await refreshBridge();
  };


  // Capture is opt-in: no source is selected by default, and a source is
  // photographed only when the student sends a question with it selected.
  const captureAllowed = permissions.some((permission) => permission.key === 'screen.capture' && permission.granted);
  const refreshCaptureSources = useCallback(async () => {
    if (!bridge || !captureAllowed) {
      setCaptureSources([]);
      setCaptureSourceId('');
      return;
    }
    const result = await bridge.observe.sources();
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    setCaptureSources(result.data);
    setCaptureSourceId((previous) => result.data.some((source) => source.id === previous) ? previous : '');
  }, [bridge, captureAllowed]);

  useEffect(() => {
    if (bubbleOpen) void refreshCaptureSources();
  }, [bubbleOpen, refreshCaptureSources]);

  // ---- boot -------------------------------------------------------------
  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    setSystemDark(mql?.matches ?? true);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql?.addEventListener?.('change', onChange);

    if (!bridge) {
      setBridgeMissing(true);
      return () => mql?.removeEventListener?.('change', onChange);
    }

    void (async () => {
      const [s, p, perms, history, resume, info] = await Promise.all([
        bridge.settings.get(),
        bridge.provider.list(),
        bridge.permissions.get(),
        bridge.chat.history(),
        bridge.learning.resume(),
        bridge.app.info(),
      ]);
      if (s.ok) setSettings(s.data);
      if (p.ok && p.data.length > 0) setProvider(p.data[0] ?? null);
      if (perms.ok) setPermissions(perms.data.map((x) => ({ key: x.key, granted: x.granted })));
      if (history.ok) setMessages(history.data);
      if (resume.ok) setGreeting(resume.data.greeting);
      void info;
      const bridgeInfo = await bridge.bridge.status();
      if (bridgeInfo.ok) setBridgeState(bridgeInfo.data);
      const diag = await bridge.diagnostics.run();
      if (diag.ok) {
        const d = diag.data as { usageToday?: { requests: number; estimatedCostUsd: number }; provider?: { dailyLimit?: number } };
        if (d.usageToday) {
          setUsage({
            requests: d.usageToday.requests,
            estimatedCostUsd: d.usageToday.estimatedCostUsd,
            limitUsd: d.provider?.dailyLimit ?? 2,
          });
        }
      }
    })();

    return () => mql?.removeEventListener?.('change', onChange);
  }, [bridge]);

  // A page the extension reports changes what Buddy knows: refresh the bridge
  // state so the settings panel shows the current course, and tell the student
  // once (not on every SPA navigation).
  useEffect(() => {
    if (!bridge) return;
    let lastUrl: string | null = null;
    const off = bridge.bridge.onPage((event) => {
      const e = event as { pendingSite?: string; page?: { url?: string; title?: string } };
      if (e.pendingSite) {
        setNotice(`Tillägget vill läsa ${e.pendingSite}. Godkänn under Inställningar → Webbläsare.`);
        void refreshBridge();
        return;
      }
      if (e.page?.url && e.page.url !== lastUrl) {
        lastUrl = e.page.url;
        void refreshBridge();
        // The heading trail is what the student is actually looking at; the panel
        // shows it so the readiness number can be judged against the context.
        const page = e.page as { headings?: { level: number; text: string }[]; headingPath?: string[] };
        if (Array.isArray(page.headingPath) && page.headingPath.length) setPosition(page.headingPath.slice(-3));
        else if (Array.isArray(page.headings) && page.headings.length) setPosition(page.headings.slice(0, 3).map((h) => h.text));
      }
    });
    return off;
  }, [bridge, refreshBridge]);

  // Greeting appears once, as a Buddy message, only when it is evidence-based.
  useEffect(() => {
    if (!greeting) return;
    setMessages((prev) =>
      prev.length === 0
        ? [
            {
              id: createId('m'),
              sessionId: 'local',
              role: 'buddy',
              text: greeting,
              structured: null,
              mode: 'NORMAL',
              createdAt: new Date().toISOString(),
            },
          ]
        : prev,
    );
  }, [greeting]);

  // ---- click-through ----------------------------------------------------
  // Track which regions contain solid UI. The mascot box is fixed; the bubble
  // grows with content, so we measure it.
  const mascotRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; windowX: number; windowY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bridge) return;
    const onMove = (event: MouseEvent) => {
      const overMascot = isInside(mascotRef.current, event.clientX, event.clientY);
      const overBubble = bubbleOpen && isInside(bubbleRef.current, event.clientX, event.clientY);
      const ignore = !dragRef.current && !(overMascot || overBubble);
      void bridge.window.setIgnoreMouse(ignore);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [bridge, bubbleOpen]);

  // A frameless Electron window has no native title bar. The monkey itself is
  // draggable, while a short click continues to toggle chat. Using pointer capture
  // avoids losing drag when the cursor leaves the character.
  const beginMascotDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !bridge) return;
    dragRef.current = {
      pointerId: event.pointerId, startX: event.screenX, startY: event.screenY,
      windowX: window.screenX, windowY: window.screenY, moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    void bridge.window.setIgnoreMouse(false);
  };
  const moveMascotDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !bridge) return;
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    void bridge.window.setPosition(drag.windowX + dx, drag.windowY + dy);
  };
  const endMascotDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  // ---- inactivity -------------------------------------------------------
  useEffect(() => {
    const reset = () => {
      setSignal('app-idle');
      if (inactivity.current) clearTimeout(inactivity.current);
      inactivity.current = setTimeout(() => setSignal('long-inactivity'), 5 * 60_000);
    };
    window.addEventListener('mousemove', reset);
    window.addEventListener('keydown', reset);
    reset();
    return () => {
      window.removeEventListener('mousemove', reset);
      window.removeEventListener('keydown', reset);
      if (inactivity.current) clearTimeout(inactivity.current);
    };
  }, []);

  // ---- chat -------------------------------------------------------------
  const send = useCallback(
    async (text: string) => {
      if (!bridge) return;
      setSignal('message-sent');
      setBubbleOpen(true);
      const optimistic: ChatMessage = {
        id: createId('m'),
        sessionId: 'local',
        role: 'user',
        text,
        structured: null,
        mode,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
      setStreaming(true);
      setNotice(null);

      const result = await bridge.chat.send({ text, mode, context: captureSourceId ? { captureSourceId } : undefined });

      setStreaming(false);
      if (!result.ok) {
        setNotice(result.error.message);
        setSignal('error');
        return;
      }

      setMessages((prev) => [...prev.filter((m) => m.id !== optimistic.id), { ...optimistic }, result.data.message]);
      if (result.data.notice) setNotice(result.data.notice);
      if (result.data.degraded) setSignal('error');
      else setSignal('answer-delivered');

      const bridgeInfo = await bridge.bridge.status();
      if (bridgeInfo.ok) setBridgeState(bridgeInfo.data);
      const diag = await bridge.diagnostics.run();
      if (diag.ok) {
        const d = diag.data as { usageToday?: { requests: number; estimatedCostUsd: number }; provider?: { dailyLimit?: number } };
        if (d.usageToday) {
          setUsage({ requests: d.usageToday.requests, estimatedCostUsd: d.usageToday.estimatedCostUsd, limitUsd: d.provider?.dailyLimit ?? 2 });
        }
      }
    },
    [bridge, mode, captureSourceId],
  );

  const changeMode = useCallback(
    (next: ResponseMode) => {
      setMode(next);
      void bridge?.settings.update({ defaultMode: next });
    },
    [bridge],
  );

  const speak = useCallback(
    async (text: string) => {
      if (!bridge) return;
      if (!settings.voice.enabled) {
        setNotice('Röst är avstängd. Slå på den i inställningarna om du vill höra svaret.');
        return;
      }
      setSpeaking(true);
      setSignal('voice-speaking');
      const result = await bridge.voice.speak(text);
      setSpeaking(false);
      setSignal('answer-delivered');
      if (!result.ok) setNotice(result.error.message);
    },
    [bridge, settings.voice.enabled],
  );

  const stopSpeech = useCallback(async () => {
    await bridge?.voice.stop();
    setSpeaking(false);
  }, [bridge]);

  // ---- settings actions -------------------------------------------------
  const saveProvider = useCallback(
    async (patch: Partial<ProviderConfig> & { apiKey?: string }) => {
      if (!bridge) return { ok: false, message: 'Bryggan saknas.' };
      const result = await bridge.provider.save(patch);
      if (!result.ok) return { ok: false, message: result.error.message };
      setProvider(result.data);
      return { ok: true, message: 'Providern sparades.' };
    },
    [bridge],
  );

  const testProvider = useCallback(async () => {
    if (!bridge) return { ok: false, message: 'Bryggan saknas.' };
    const result = await bridge.provider.test();
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: result.data.ok, message: `${result.data.detail} (${result.data.latencyMs} ms)` };
  }, [bridge]);

  const probeCapabilities = useCallback(async () => {
    if (!bridge) return { ok: false, message: 'Bryggan saknas.' };
    // Capability probing lives behind the diagnostics channel.
    const result = await bridge.diagnostics.run();
    if (!result.ok) return { ok: false, message: result.error.message };
    const d = result.data as { provider?: { capabilities?: ModelCapabilities } };
    if (d.provider?.capabilities) {
      setCapabilities(d.provider.capabilities);
      return { ok: true, message: 'Funktioner uppmätta.' };
    }
    return { ok: false, message: 'Ingen mätning kunde genomföras. Kontrollera providern.' };
  }, [bridge]);

  const onPermission = useCallback(
    async (key: PermissionKey, granted: boolean) => {
      if (!bridge) return;
      const result = granted ? await bridge.permissions.grant(key) : await bridge.permissions.revoke(key);
      if (result.ok) setPermissions((prev) => prev.map((p) => (p.key === key ? { ...p, granted } : p)));
    },
    [bridge],
  );

  const onModeChange = useCallback(
    async (next: PermissionMode) => {
      if (!bridge) return;
      await bridge.permissions.setMode(next);
      setSettings((prev) => ({ ...prev, permissionMode: next }));
    },
    [bridge],
  );

  const onSettingsChange = useCallback(
    async (patch: Partial<Settings>) => {
      if (!bridge) return;
      const result = await bridge.settings.update(patch);
      if (result.ok) setSettings(result.data);
    },
    [bridge],
  );

  const resetLearning = useCallback(async () => {
    if (!bridge) return;
    await bridge.chat.reset();
    setMessages([]);
    setNotice('Inlärningshistoriken raderades för den här sessionen.');
  }, [bridge]);

  const visibleMessages = useMemo(() => messages.slice(-40), [messages]);

  return (
    <div className={`studdy-root ${bubbleOpen ? 'is-open' : ''}`}>
      <style>{rootCss}</style>

      {bridgeMissing && (
        <div className="studdy-no-bridge" role="status">
          Buddy körs utanför Electron. Starta desktopappen för att chatten ska fungera.
        </div>
      )}

      <div className="studdy-mascot-zone" ref={mascotRef}>
        <button
          type="button"
          className="studdy-mascot-btn"
          aria-label={bubbleOpen ? 'Stäng samtalet med Buddy' : 'Öppna samtal med Buddy'}
          onPointerDown={beginMascotDrag}
          onPointerMove={moveMascotDrag}
          onPointerUp={endMascotDrag}
          onPointerCancel={endMascotDrag}
          onClick={() => {
            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
            setBubbleOpen((open) => !open);
            setSignal(bubbleOpen ? 'app-idle' : 'user-typing');
          }}
          onDoubleClick={() => setView('settings')}
        >
          <Buddy size={116} signal={signal} reducedMotion={settings.reducedMotion} />
        </button>

        <div className="studdy-mascot-hint" aria-hidden={bubbleOpen}>
          {!bubbleOpen && <span>Klicka för att fråga</span>}
        </div>

        <div className="studdy-mascot-tools">
          <button
            type="button"
            aria-label="Framsteg och tentaberedskap"
            onClick={() => {
              if (view !== 'progress') void refreshProgress();
              setView(view === 'progress' ? 'chat' : 'progress');
            }}
            title="Framsteg"
          >
            ◎
          </button>
          <button type="button" aria-label="Inställningar" onClick={() => setView(view === 'settings' ? 'chat' : 'settings')} title="Inställningar">
            ⚙
          </button>
          {settings.voice.enabled && (
            <button
              type="button"
              aria-label={speaking ? 'Stoppa rösten' : 'Röst av'}
              onClick={() => void (speaking ? stopSpeech() : undefined)}
              className={speaking ? 'is-active' : ''}
              title={speaking ? 'Stoppa rösten' : 'Röst på'}
            >
              {speaking ? '■' : '♪'}
            </button>
          )}
        </div>
      </div>

      {bubbleOpen && (
        <div className="studdy-bubble-zone" ref={bubbleRef}>
          {view === 'progress' ? (
            readiness ? (
              <ProgressPanel
                theme={theme}
                readiness={readiness}
                course={courseInfo}
                currentPosition={position}
                platform={platformProgress}
                onClose={() => setView('chat')}
              />
            ) : (
              <div className="studdy-progress-empty">
                <p>Framstegen kunde inte läsas just nu.</p>
                <button type="button" className="buddy-p-btn" onClick={() => void refreshProgress()}>
                  Försök igen
                </button>
              </div>
            )
          ) : view === 'settings' ? (
            <SettingsPanelPlaceholder
              theme={theme}
              settings={settings}
              provider={provider}
              capabilities={null}
              permissions={permissions}
              usage={usage}
              onSaveProvider={saveProvider}
              onTestProvider={testProvider}
              onProbeCapabilities={probeCapabilities}
              onPermission={(k, g) => void onPermission(k, g)}
              onModeChange={(m) => void onModeChange(m)}
              onSettingsChange={(p) => void onSettingsChange(p)}
              onClose={() => setView('chat')}
              onResetLearningData={() => void resetLearning()}
              bridge={bridgeState ?? undefined}
              onAddSite={addSite}
              onRemoveSite={removeSite}
              onRotateBridgeToken={rotateBridgeToken}
            />
          ) : (
            <ChatBubble
              messages={visibleMessages}
              captureSources={captureSources}
              captureSourceId={captureSourceId}
              onCaptureSourceChange={captureAllowed ? setCaptureSourceId : undefined}
              onRefreshCaptureSources={captureAllowed ? () => void refreshCaptureSources() : undefined}
              mode={mode}
              onModeChange={changeMode}
              onSend={(text) => void send(text)}
              onCancel={() => void bridge?.chat.cancel()}
              theme={theme}
              onClose={() => setBubbleOpen(false)}
              onSpeak={(text) => void speak(text)}
              onStopSpeech={() => void stopSpeech()}
              speaking={speaking}
              streaming={streaming}
              reducedMotion={settings.reducedMotion}
              notice={notice}
              placeholder={provider ? 'Fråga Buddy…' : 'Ange en AI-provider i inställningarna först'}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SettingsPanelPlaceholder(props: React.ComponentProps<typeof SettingsPanel>) {
  return <SettingsPanel {...props} />;
}

function isInside(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

const rootCss = `
html, body, #root { margin:0; padding:0; background: transparent; overflow: hidden; height: 100%; }
.studdy-root {
  position: relative; width: 100%; height: 100vh;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-user-select: none; user-select: none;
}
.studdy-no-bridge {
  position: absolute; left: 8px; top: 8px; right: 8px; z-index: 20;
  background: rgba(180,64,47,0.92); color:#fff; font-size: 11px; padding: 6px 8px; border-radius: 8px;
}
.studdy-mascot-zone {
  position: absolute; left: 8px; top: 8px; width: 132px; height: 132px;
  display: flex; align-items: center; justify-content: center;
  -webkit-app-region: no-drag;
}
.studdy-mascot-btn {
  background: none; border: none; padding: 0; cursor: grab; touch-action: none; -webkit-app-region: no-drag;
  border-radius: 50%; transition: transform 160ms ease;
}
.studdy-mascot-btn:active { cursor: grabbing; }\n.studdy-mascot-btn:hover { transform: scale(1.03); }
.studdy-mascot-btn:focus-visible { outline: 2px solid #8FCBAE; outline-offset: 4px; }
.studdy-mascot-hint {
  position: absolute; bottom: -4px; left: 0; right: 0; text-align: center;
  font-size: 10px; color: rgba(255,255,255,0.78); text-shadow: 0 1px 6px rgba(0,0,0,0.6);
  pointer-events: none;
}
.studdy-mascot-tools {
  position: absolute; right: -6px; top: 4px; display: flex; flex-direction: column; gap: 4px;
  opacity: 0; transition: opacity 140ms ease; -webkit-app-region: no-drag;
}
.studdy-mascot-zone:hover .studdy-mascot-tools { opacity: 1; }
.studdy-mascot-tools button {
  width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.16);
  background: rgba(24,26,31,0.82); color: rgba(255,255,255,0.8); font-size: 11px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.studdy-mascot-tools button.is-active { background: #8FCBAE; color: #0E1512; }
.studdy-bubble-zone {
  position: absolute; left: 8px; top: 146px; width: 344px; -webkit-app-region: no-drag;
  animation: studdy-rise 180ms ease-out;
}
@keyframes studdy-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
