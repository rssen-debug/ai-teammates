import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ResponseMode, StructuredResponse } from '@studdy/shared';
import { countWords } from '@studdy/shared';
import { darkTheme, themeToCssVars, type Theme } from './theme.js';

/**
 * The conversation bubble: the product's primary interface.
 *
 * Design intent (from the brief): minimal, calm, elegant; the bubble is the
 * frame, the mascot is the product. Nothing here is a dashboard.
 *
 * Behavioural rules implemented here rather than left to the model:
 *  - progressive disclosure: "Visa mer" reveals example/deeper text
 *  - code/CLI blocks are monospace and copyable
 *  - length badge appears when an answer exceeds the mode policy, so the
 *    student can see that Buddy is being brief on purpose
 *  - all controls reachable by keyboard; dismiss with Escape
 */

export interface ChatBubbleProps {
  messages: ChatMessage[];
  mode: ResponseMode;
  onModeChange: (mode: ResponseMode) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onClose: () => void;
  onSpeak?: (text: string) => void;
  onStopSpeech?: () => void;
  speaking?: boolean;
  streaming?: boolean;
  theme?: Theme;
  reducedMotion?: boolean;
  notice?: string | null;
  placeholder?: string;
  disabled?: boolean;
  captureSources?: { id: string; name: string }[];
  captureSourceId?: string;
  captureActive?: boolean;
  studyPresence?: string;
  onCaptureSourceChange?: (sourceId: string) => void;
  onRefreshCaptureSources?: () => void;
}

const MODES: { id: ResponseMode; label: string; hint: string }[] = [
  { id: 'QUICK', label: 'Snabb', hint: '1–2 meningar' },
  { id: 'NORMAL', label: 'Normal', hint: '2–4 meningar' },
  { id: 'TEACH', label: 'Lär', hint: 'Förklaring + exempel' },
  { id: 'STEP_BY_STEP', label: 'Steg', hint: 'En åtgärd i taget' },
  { id: 'DEBUG', label: 'Felsök', hint: 'En diagnos i taget' },
  { id: 'DEEP', label: 'Djup', hint: 'Längre förklaring' },
];

export function ChatBubble(props: ChatBubbleProps) {
  const theme = props.theme ?? darkTheme;
  const [draft, setDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages.length, props.streaming]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const text = draft.trim();
    if (!text || props.disabled) return;
    props.onSend(text);
    setDraft('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <div
      style={{ ...themeToCssVars(theme) as React.CSSProperties, fontFamily: theme.font.ui }}
      className="buddy-bubble-root"
      role="dialog"
      aria-label="Samtal med Buddy"
    >
      <style>{bubbleCss}</style>

      <header className="buddy-bubble-header">
        <div className="buddy-bubble-title">
          <span className="buddy-bubble-dot" aria-hidden="true" />
          Buddy
          {props.streaming ? <span className="buddy-bubble-status">tänker…</span> :
            props.studyPresence ? <span className="buddy-bubble-status" title="Buddy observerar bara tillåtna studiesammanhang; inga bilder skickas förrän du frågar.">{props.studyPresence}</span> : null}
        </div>
        <div className="buddy-bubble-actions">
          <button
            type="button"
            className="buddy-icon-btn"
            aria-label="Byt svarsläge"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((s) => !s)}
          >
            {modeLabel(props.mode)}
          </button>
          <button type="button" className="buddy-icon-btn" aria-label="Stäng samtalet" onClick={props.onClose}>
            ✕
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="buddy-mode-row" role="group" aria-label="Svarsläge">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`buddy-chip ${props.mode === m.id ? 'is-active' : ''}`}
              title={m.hint}
              aria-pressed={props.mode === m.id}
              onClick={() => {
                props.onModeChange(m.id);
                setShowSettings(false);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {props.onCaptureSourceChange && (
        <div className="buddy-capture-row">
          <label htmlFor="buddy-capture-source">{props.captureActive ? 'Fönster valt' : 'Skärmkälla'}</label>
          <select id="buddy-capture-source" aria-label="Välj fönster att dela med Buddy"
            value={props.captureSourceId ?? ''} onChange={(event) => props.onCaptureSourceChange?.(event.target.value)}>
            <option value="">Ingen skärmbild delas</option>
            {(props.captureSources ?? []).map((source) => (
              <option key={source.id} value={source.id}>{source.name}</option>
            ))}
          </select>
          <button type="button" aria-label="Uppdatera fönsterlistan" title="Uppdatera fönster"
            onClick={props.onRefreshCaptureSources}>↻</button>
        </div>
      )}

      {props.notice && (
        <div className="buddy-notice" role="status">
          {props.notice}
        </div>
      )}

      <div className="buddy-bubble-scroll" ref={scrollRef} aria-live="polite" aria-relevant="additions text">
        {props.messages.length === 0 && (
          <div className="buddy-empty">
            <p>Buddy är din desktop-agent. Fråga om det du arbetar med, i vilket program som helst.</p>
            <p className="buddy-empty-hint">Testa: ”Öppna miniräknaren”, ”Öppna mitt minne” eller välj ett fönster och fråga vad Buddy ser.</p>
            <p className="buddy-empty-hint">Röst är av tills du begär den. Skärmen delas bara med tillåtelse.</p>
          </div>
        )}
        {props.messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            reducedMotion={props.reducedMotion ?? false}
            onSpeak={props.onSpeak}
            onStopSpeech={props.onStopSpeech}
            onChip={(text) => props.onSend(text)}
            speaking={props.speaking ?? false}
          />
        ))}
      </div>

      <div className="buddy-composer">
        <textarea
          ref={inputRef}
          className="buddy-input"
          value={draft}
          placeholder={props.placeholder ?? 'Fråga Buddy… (Enter skickar, Shift+Enter ny rad)'}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={props.disabled}
          aria-label="Skriv till Buddy"
        />
        {props.streaming ? (
          <button type="button" className="buddy-send is-stop" onClick={props.onCancel} aria-label="Avbryt svaret">
            ■
          </button>
        ) : (
          <button type="button" className="buddy-send" onClick={submit} disabled={!draft.trim() || props.disabled} aria-label="Skicka">
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

function modeLabel(mode: ResponseMode): string {
  return MODES.find((m) => m.id === mode)?.label ?? mode;
}

function MessageView({
  message,
  reducedMotion,
  onSpeak,
  onStopSpeech,
  onChip,
  speaking,
}: {
  message: ChatMessage;
  reducedMotion: boolean;
  onSpeak?: (text: string) => void;
  onStopSpeech?: () => void;
  onChip?: (text: string) => void;
  speaking: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const structured = message.structured;
  const isUser = message.role === 'user';
  const words = countWords(message.text);

  const segments = useMemo(() => splitCodeSegments(message.text), [message.text]);

  if (isUser) {
    return (
      <div className="buddy-msg buddy-msg-user">
        <div className="buddy-bubble-user">{message.text}</div>
      </div>
    );
  }

  return (
    <div className="buddy-msg buddy-msg-buddy">
      <div className="buddy-bubble-buddy">
        {message.error && <div className="buddy-error">{message.error}</div>}

        {segments.map((seg, i) =>
          seg.type === 'code' ? (
            <CodeBlock key={i} code={seg.text} language={seg.language} />
          ) : (
            <p key={i} className="buddy-text">
              {seg.text}
            </p>
          ),
        )}

        {structured && (
          <StructuredView structured={structured} expanded={expanded} reducedMotion={reducedMotion} />
        )}

        <footer className="buddy-msg-footer">
          {structured?.deeperExplanation && (
            <button type="button" className="buddy-link" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Visa mindre' : 'Visa mer'}
            </button>
          )}
          {words > 90 && <span className="buddy-len-badge">{words} ord</span>}
          {onSpeak && (
            <button type="button" className="buddy-link" onClick={() => (speaking ? onStopSpeech?.() : onSpeak(message.text))}>
              {speaking ? 'Stoppa rösten' : 'Läs upp'}
            </button>
          )}
        </footer>

        {message.chips && message.chips.length > 0 && (
          <div className="buddy-chips">
            {message.chips.map((chip) => (
              <button key={chip} type="button" className="buddy-chip buddy-chip-action" onClick={() => onChip?.(chip)}>
                {chip}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StructuredView({ structured, expanded, reducedMotion }: { structured: StructuredResponse; expanded: boolean; reducedMotion: boolean }) {
  const hasExtra = Boolean(structured.example || structured.deeperExplanation || structured.nextAction);
  if (!hasExtra) return null;
  return (
    <div className="buddy-struct">
      {structured.example && (
        <div className="buddy-example">
          <span className="buddy-example-label">Exempel</span>
          <span>{structured.example}</span>
        </div>
      )}
      {structured.nextAction && (
        <div className="buddy-next" style={{ animation: reducedMotion ? 'none' : undefined }}>
          <span className="buddy-next-label">Nästa steg</span>
          <span>{structured.nextAction}</span>
        </div>
      )}
      {expanded && structured.deeperExplanation && <p className="buddy-text buddy-deeper">{structured.deeperExplanation}</p>}
      {structured.confidence === 'low' && <div className="buddy-confidence">Låg säkerhet – kontrollera i kursmaterialet.</div>}
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="buddy-code">
      <div className="buddy-code-head">
        <span>{language ?? 'cli'}</span>
        <button
          type="button"
          className="buddy-link"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Kopierat' : 'Kopiera'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Splits text into prose and fenced code so commands render correctly. */
export function splitCodeSegments(text: string): { type: 'text' | 'code'; text: string; language: string | null }[] {
  const out: { type: 'text' | 'code'; text: string; language: string | null }[] = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      const before = text.slice(last, match.index).trim();
      if (before) out.push({ type: 'text', text: before, language: null });
    }
    out.push({ type: 'code', text: (match[2] ?? '').trim(), language: match[1] || null });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ type: 'text', text: rest, language: null });
  if (out.length === 0) out.push({ type: 'text', text, language: null });
  return out;
}

const bubbleCss = `
.buddy-bubble-root {
  width: 100%; max-width: 380px; display: flex; flex-direction: column; max-height: 560px;
  background: var(--buddy-surface); color: var(--buddy-text);
  border: 1px solid var(--buddy-border); border-radius: var(--buddy-radius-lg);
  box-shadow: var(--buddy-shadow); backdrop-filter: blur(18px) saturate(120%);
  overflow: hidden; font-size: var(--buddy-font-ui);
}
.buddy-capture-row { display:flex; align-items:center; gap:6px; padding: 0 12px 9px; color:var(--buddy-text-muted); font-size:11px; }
.buddy-capture-row label { white-space:nowrap; }
.buddy-capture-row select { min-width:0; flex:1; padding:5px 6px; color:var(--buddy-text); background:var(--buddy-surface-sunken); border:1px solid var(--buddy-border); border-radius:7px; font-size:11px; }
.buddy-capture-row button { color:var(--buddy-text); background:transparent; border:1px solid var(--buddy-border); border-radius:7px; cursor:pointer; }
.buddy-capture-row :focus-visible { outline:2px solid var(--buddy-accent); }
.buddy-bubble-header { display:flex; align-items:center; justify-content:space-between; padding: 10px 12px 8px; }
.buddy-bubble-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; letter-spacing:0.01em; }
.buddy-bubble-dot { width:8px; height:8px; border-radius:50%; background: var(--buddy-accent); box-shadow: 0 0 0 3px var(--buddy-accent-soft); }
.buddy-bubble-status { font-weight:400; color: var(--buddy-text-faint); font-size:11.5px; }
.buddy-bubble-actions { display:flex; gap:6px; }
.buddy-icon-btn {
  background: transparent; border: 1px solid var(--buddy-border); color: var(--buddy-text-muted);
  border-radius: var(--buddy-radius-pill); padding: 3px 10px; font-size:11.5px; cursor:pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.buddy-icon-btn:hover { background: var(--buddy-accent-soft); color: var(--buddy-text); border-color: var(--buddy-border-strong); }
.buddy-icon-btn:focus-visible, .buddy-chip:focus-visible, .buddy-send:focus-visible, .buddy-link:focus-visible, .buddy-input:focus-visible {
  outline: 2px solid var(--buddy-accent); outline-offset: 2px;
}
.buddy-mode-row { display:flex; flex-wrap:wrap; gap:6px; padding: 0 12px 10px; }
.buddy-chip {
  background: var(--buddy-surface-sunken); border:1px solid var(--buddy-border); color: var(--buddy-text-muted);
  border-radius: var(--buddy-radius-pill); padding: 4px 10px; font-size:11.5px; cursor:pointer;
}
.buddy-chip.is-active { background: var(--buddy-accent-soft); color: var(--buddy-accent); border-color: var(--buddy-accent); }
.buddy-chip-action { background: var(--buddy-accent-soft); color: var(--buddy-accent); }
.buddy-notice {
  margin: 0 12px 8px; padding: 8px 10px; border-radius: var(--buddy-radius-sm);
  background: var(--buddy-danger-soft); color: var(--buddy-text); font-size: 12px; line-height:1.35;
}
.buddy-bubble-scroll { overflow-y:auto; padding: 4px 12px 8px; flex:1; }
.buddy-empty { color: var(--buddy-text-faint); font-size:12.5px; padding: 14px 4px; }
.buddy-empty p { margin: 0 0 6px; }
.buddy-empty-hint { font-size:11.5px; color: var(--buddy-text-faint); opacity:0.85; }
.buddy-msg { display:flex; margin-bottom: 10px; }
.buddy-msg-user { justify-content: flex-end; }
.buddy-bubble-user {
  background: var(--buddy-accent); color: var(--buddy-accent-text); padding: 8px 12px;
  border-radius: var(--buddy-radius-md); border-bottom-right-radius: 4px; font-size:13px; line-height:1.45; max-width: 88%;
}
.buddy-bubble-buddy {
  background: var(--buddy-surface-raised); border: 1px solid var(--buddy-border);
  border-radius: var(--buddy-radius-md); border-bottom-left-radius: 4px; padding: 10px 12px; max-width: 94%;
  box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset;
}
.buddy-text { margin: 0 0 8px; font-size:13.5px; line-height:1.5; }
.buddy-text:last-of-type { margin-bottom: 4px; }
.buddy-deeper { color: var(--buddy-text-muted); border-left: 2px solid var(--buddy-border-strong); padding-left: 10px; }
.buddy-struct { display:flex; flex-direction:column; gap:8px; margin: 6px 0; }
.buddy-example, .buddy-next {
  display:flex; flex-direction:column; gap:2px; padding: 8px 10px; border-radius: var(--buddy-radius-sm);
  background: var(--buddy-surface-sunken); font-size:12.5px; line-height:1.45;
}
.buddy-example-label, .buddy-next-label {
  font-size:10.5px; text-transform:uppercase; letter-spacing:0.07em; color: var(--buddy-text-faint);
}
.buddy-next { border: 1px solid var(--buddy-accent-soft); }
.buddy-confidence { font-size:11px; color: var(--buddy-warning); }
.buddy-msg-footer { display:flex; align-items:center; gap:10px; margin-top: 4px; }
.buddy-link {
  background:none; border:none; padding:0; color: var(--buddy-accent); font-size:11.5px; cursor:pointer;
  text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px;
}
.buddy-len-badge { font-size:10.5px; color: var(--buddy-text-faint); }
.buddy-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.buddy-error { color: var(--buddy-danger); font-size:12px; margin-bottom:6px; }
.buddy-code { border-radius: var(--buddy-radius-sm); overflow:hidden; border:1px solid var(--buddy-border); margin: 6px 0; }
.buddy-code-head {
  display:flex; justify-content:space-between; align-items:center; padding: 4px 8px;
  background: var(--buddy-surface-sunken); font-size:10.5px; color: var(--buddy-text-faint);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.buddy-code pre { margin:0; padding: 8px 10px; background: var(--buddy-surface-sunken); overflow-x:auto; }
.buddy-code code { font-family: var(--buddy-font-mono); font-size: 12px; line-height:1.5; color: var(--buddy-text); }
.buddy-composer {
  display:flex; align-items:flex-end; gap:8px; padding: 10px 12px 12px; border-top: 1px solid var(--buddy-border);
  background: var(--buddy-surface-raised);
}
.buddy-input {
  flex:1; resize:none; border:none; background: transparent; color: var(--buddy-text);
  font-family: var(--buddy-font-ui); font-size: 13px; line-height: 1.45; max-height: 120px; padding: 6px 2px;
}
.buddy-input::placeholder { color: var(--buddy-text-faint); }
.buddy-input:focus { outline: none; }
.buddy-send {
  width: 30px; height: 30px; border-radius: 50%; border: none; cursor:pointer;
  background: var(--buddy-accent); color: var(--buddy-accent-text); font-size: 14px; font-weight: 600;
  display:flex; align-items:center; justify-content:center; transition: transform 120ms ease, opacity 120ms ease;
}
.buddy-send:disabled { opacity: 0.35; cursor: default; }
.buddy-send:not(:disabled):hover { transform: translateY(-1px); }
.buddy-send.is-stop { background: var(--buddy-danger); color: #fff; font-size: 11px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;
