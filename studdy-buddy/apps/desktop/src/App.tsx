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
  const [githubDebug, setGithubDebug] = useState<{ repository: string; enabled: boolean; hasToken: boolean; target: string } | null>(null);
  const [permissions, setPermissions] = useState<{ key: PermissionKey; granted: boolean }[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mode, setMode] = useState<ResponseMode>('NORMAL');
  const [streaming, setStreaming] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('chat');
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [signal, setSignal] = useState<MascotSignal>('app-idle');
  const [mascotGaze, setMascotGaze] = useState<{ x: number; y: number } | null>(null);
  const [greeting, setGreeting] = useState<string | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [bridgeState, setBridgeState] = useState<BridgePanelState | null>(null);
  const [captureSources, setCaptureSources] = useState<{ id: string; name: string }[]>([]);
  const [captureSourceId, setCaptureSourceId] = useState('');
  const [liveContext, setLiveContext] = useState('Redo');
  const [observation, setObservation] = useState<{ connected: boolean; observing: boolean; windowTitle: string | null; lastObservedAt: number | null }>({ connected: false, observing: false, windowTitle: null, lastObservedAt: null });
  const [readiness, setReadiness] = useState<ReadinessScore | null>(null);
  const [courseInfo, setCourseInfo] = useState<{ name: string; moduleCount: number } | null>(null);
  const [platformProgress, setPlatformProgress] = useState<{ completed: number; total: number } | null>(null);
  const [position, setPosition] = useState<string[] | null>(null);
  const [systemDark, setSystemDark] = useState(true);
  const inactivity = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSelectionHelpAt = useRef(0);
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

  const refreshGitHubDebug = useCallback(async () => {
    if (!bridge) return;
    const result = await bridge.diagnostics.githubStatus();
    if (result.ok) setGithubDebug(result.data);
  }, [bridge]);

  const configureGitHub = useCallback(async (config: { repository: string; token?: string; enabled: boolean }) => {
    if (!bridge) return { ok: false, message: 'Appkoppling saknas.' };
    const result = await bridge.diagnostics.githubConfigure(config);
    if (!result.ok) return { ok: false, message: result.error.message };
    setGithubDebug(result.data);
    return { ok: true, message: config.enabled ? 'Sparat! Rensade felkoder synkas nu automatiskt.' : 'GitHub-synk är avstängd.' };
  }, [bridge]);

  const syncGitHubNow = useCallback(async () => {
    if (!bridge) return { ok: false, message: 'Appkoppling saknas.' };
    const result = await bridge.diagnostics.githubSyncNow();
    return result.ok ? { ok: result.data.ok, message: result.data.detail }
      : { ok: false, message: result.error.message };
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
  const dataSharingAllowed = permissions.some((permission) => permission.key === 'provider.dataShare' && permission.granted);
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
    // Within an authorized study session, automatically reuse the single
    // visible Packet Tracer source. Never auto-select a generic browser window
    // because unrelated private tabs may be open there.
    const packetTracer = result.data.filter((source) => /packet\s*tracer/i.test(source.name));
    if (packetTracer.length === 1) setLiveContext('Packet Tracer ansluten');
    setCaptureSourceId((previous) => result.data.some((source) => source.id === previous)
      ? previous
      : packetTracer.length === 1 ? packetTracer[0]!.id : '');
  }, [bridge, captureAllowed]);

  // The selected app, not the entire desktop, is the persistent universal
  // context source. Electron IDs are checked again in the main process.
  useEffect(() => {
    if (!bridge) return;
    void bridge.observe.selectWindow(captureAllowed ? captureSourceId || null : null)
      .then((result) => { if (!result.ok && captureSourceId) setNotice(result.error.message); });
  }, [bridge, captureAllowed, captureSourceId]);

  useEffect(() => {
    if (!captureAllowed || !provider?.hasApiKey) return;
    // Always-ready study observation: a scoped, low-frequency window title
    // check. No screenshots or cloud calls are made by this loop.
    void refreshCaptureSources();
    const interval = window.setInterval(() => void refreshCaptureSources(), 10_000);
    return () => window.clearInterval(interval);
  }, [captureAllowed, provider?.hasApiKey, refreshCaptureSources]);

  useEffect(() => {
    if (bubbleOpen && !captureAllowed) setLiveContext('Redo');
  }, [bubbleOpen, captureAllowed]);

  // Display *actual* native-observer activity. API connection alone is not
  // evidence Buddy can read the user's screen.
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const read = async () => {
      const result = await bridge.observe.liveStatus();
      if (active && result.ok) setObservation(result.data);
    };
    void read();
    const timer = window.setInterval(() => void read(), 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [bridge]);

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
      void refreshGitHubDebug();
      if (p.ok && p.data.length > 0) setProvider(p.data[0] ?? null);
      // First launch needs only a provider key; open the compact onboarding
      // automatically rather than forcing the student through settings tabs.
      if (!p.ok || !p.data[0]?.hasApiKey) {
        setBubbleOpen(true);
        setView('settings');
      }
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
  }, [bridge, refreshGitHubDebug]);

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
        setLiveContext('Webbläsare ansluten');
        setSignal('hint-shown');
        void refreshProgress();
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
  }, [bridge, refreshBridge, refreshProgress]);

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
      if (overMascot && mascotRef.current) {
        const r = mascotRef.current.getBoundingClientRect();
        setMascotGaze({ x: (event.clientX - r.left - r.width / 2) / (r.width / 2), y: (event.clientY - r.top - r.height / 2) / (r.height / 2) });
      }
      // OS-level pointer hit testing in Electron now owns click-through.
      // Never race it from a React mousemove handler (first click loss).
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
      inactivity.current = setTimeout(() => setSignal(captureSourceId ? 'app-idle' : 'long-inactivity'), 5 * 60_000);
    };
    window.addEventListener('mousemove', reset);
    window.addEventListener('keydown', reset);
    reset();
    return () => {
      window.removeEventListener('mousemove', reset);
      window.removeEventListener('keydown', reset);
      if (inactivity.current) clearTimeout(inactivity.current);
    };
  }, [captureSourceId]);

  // ---- chat -------------------------------------------------------------
  const send = useCallback(
    async (text: string, selectedText?: string) => {
      if (!bridge) return;
      // Never let the model answer a screen-awareness question without visual
      // evidence: doing so produces the misleading 'I cannot see your screen'.
      const isScreenQuestion = /(?:sk[aä]rm|f[oö]nster|screen|packet\s*tracer|vad ser du|what do you see)/i.test(text);
      if (isScreenQuestion && !captureSourceId && !selectedText) {
        setNotice(captureAllowed
          ? 'Välj Packet Tracer eller Chrome under Skärmkälla ovan och fråga igen. Ingen skärmbild har skickats.'
          : 'Öppna Inställningar → Behörigheter och aktivera Skärmbild. Välj sedan ett fönster under Skärmkälla.');
        setBubbleOpen(true);
        return;
      }
      if (captureSourceId && !dataSharingAllowed) {
        setNotice('Öppna Inställningar → Behörigheter och aktivera Skicka kontext till AI för att analysera det valda fönstret.');
        return;
      }
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

      const result = await bridge.chat.send({ text, mode, context: selectedText ? { selectedText } : captureSourceId ? { captureSourceId } : undefined });

      setStreaming(false);
      if (!result.ok) {
        setNotice(result.error.message);
        setSignal('error');
        return;
      }

      setMessages((prev) => [...prev.filter((m) => m.id !== optimistic.id), { ...optimistic }, result.data.message]);
      if (result.data.notice || result.data.error) setNotice(result.data.notice ?? result.data.error);
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
    [bridge, mode, captureSourceId, captureAllowed, dataSharingAllowed, provider?.visionModelId],
  );

  // Reactive browser-selection assistance. The extension has already
  // restricted events to allowed sites; never observe arbitrary browser tabs.
  // No always-on screen capture or LLM polling. One lightweight call only
  // after an intentional text selection, with a cooldown to avoid spam/costs.
  useEffect(() => {
    if (!bridge || settings.proactive === 'OFF' || !provider?.hasApiKey || !dataSharingAllowed ||
        !permissions.some(p => p.key === 'browser.read' && p.granted)) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = bridge.bridge.onSelection((event: unknown) => {
      const selection = event as { text?: string; url?: string };
      const highlighted = typeof selection.text === 'string' ? selection.text.trim() : '';
      if (highlighted.length < 9 || highlighted.length > 450 || streaming) return;
      if (/\b(?:password|lösenord|token|secret|api.key|authorization|bearer|private.key|personnummer|bankid)\b/i.test(highlighted) ||
          /\beyJ[A-Za-z0-9_-]{12,}\./.test(highlighted)) return;
      // For assessments, do not auto-answer questions or interrupt a test.
      if (/quiz|exam|assessment|prov|tentamen|testattempt/i.test(selection.url ?? '')) return;
      const now = Date.now();
      if (now - lastSelectionHelpAt.current < (settings.proactive === 'QUIET' ? 90_000 : 30_000)) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        lastSelectionHelpAt.current = Date.now();
        setView('chat');
        setBubbleOpen(true);
        setLiveContext('Markering upptäckt · hjälper dig');
        setSignal('hint-shown');
        void send('Förklara kort och enkelt den här markerade texten på svenska. Börja direkt med poängen, ge ett exempel om det behövs.', highlighted);
      }, 700);
    });
    return () => {
      if (pending) clearTimeout(pending);
      unsubscribe();
    };
  }, [bridge, settings.proactive, provider?.hasApiKey, dataSharingAllowed, permissions, send, streaming]);

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

  // One-click navigation. Never leave a hidden settings/progress view open
  // behind a collapsed chat; that was causing the "click several times" bug.
  const openView = (next: View) => {
    if (next === 'progress') void refreshProgress();
    setView(next);
    setBubbleOpen(true);
  };
  useEffect(() => {
    void bridge?.window.setExpanded(bubbleOpen);
  }, [bridge, bubbleOpen]);

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
          aria-label="Öppna chatten med Buddy"
          onPointerDown={beginMascotDrag}
          onPointerMove={moveMascotDrag}
          onPointerUp={endMascotDrag}
          onPointerCancel={endMascotDrag}
          onClick={() => {
            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
            openView('chat');
            setSignal('user-typing');
          }}
        >
          <Buddy size={116} signal={signal} studyLive={observation.observing} lookAt={mascotGaze} reducedMotion={settings.reducedMotion} />
        </button>

        <div className="studdy-mascot-hint" aria-hidden={bubbleOpen}>
          {!bubbleOpen && <span>Buddy · klicka för chatt</span>}
        </div>

        <div className="studdy-mascot-tools">
          <button
            type="button"
            aria-label="Framsteg och tentaberedskap"
            onClick={() => {
              openView('progress');
            }}
            title="Framsteg"
          >
            ◎
          </button>
          <button type="button" aria-label="Inställningar" onClick={() => openView('settings')} title="Inställningar">
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
              githubDebug={githubDebug}
              onGitHubConfigure={configureGitHub}
              onGitHubSyncNow={syncGitHubNow}
            />
          ) : (
            <ChatBubble
              messages={visibleMessages}
              captureSources={captureSources}
              captureSourceId={captureSourceId}
              captureActive={Boolean(captureSourceId)}
              studyPresence={streaming ? 'Svarar…' : observation.observing ? 'GRÖN · läser valt fönster' : provider?.hasApiKey ? 'REDO · ingen skärm läses' : 'Anslut AI-nyckel'}
              onCaptureSourceChange={captureAllowed ? (sourceId) => {
                setCaptureSourceId(sourceId);
                setLiveContext(sourceId ? 'Universell agent · valt fönster aktivt' : 'Redo när du behöver hjälp');
              } : undefined}
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
.studdy-mascot-tools { opacity: .95; }
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
.studdy-views {
  box-sizing: border-box; display: flex; gap: 5px; align-items: center;
  margin-bottom: 8px; padding: 5px; border: 1px solid #3a414c;
  border-radius: 11px; background: rgba(22, 25, 32, .97);
  box-shadow: 0 9px 28px rgba(0,0,0,.24);
}
.studdy-views button {
  flex: 1; min-width: 0; border: 0; border-radius: 8px; padding: 7px 2px;
  background: transparent; color: #abb3c0; font: 500 11px ui-sans-serif, system-ui, sans-serif;
  cursor: pointer; white-space: nowrap;
}
.studdy-views button.selected { background: #343c46; color: #f0faf4; }
.studdy-views button:focus-visible { outline: 2px solid #78dba4; outline-offset: 2px; }
.studdy-bubble-zone .buddy-settings { max-height: calc(100vh - 205px); box-sizing: border-box; overflow-y: auto; }
.studdy-bubble-zone .buddy-bubble-root { max-height: calc(100vh - 205px); }
@keyframes studdy-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
