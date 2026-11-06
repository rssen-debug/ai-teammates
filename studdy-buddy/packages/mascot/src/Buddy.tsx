import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EXPRESSIONS, STATE_LABEL, initialMascotState, tick, transition, type AnimationState, type MascotSignal, type MascotControllerState } from './states.js';

/**
 * Buddy: the animated monkey.
 *
 * Why SVG + CSS rather than a Rive asset: this ships inside Electron and must
 * work with no network, no binary asset pipeline, no vendor runtime, and stay
 * crisp at any DPI. Every animation is defined here in code, so the character
 * is original, reviewable, and adjustable per-state without a design tool.
 *
 * Accessibility: the SVG is decorative (aria-hidden) and the *state* is
 * announced separately via a polite live region, so screen-reader users get
 * "Buddy tänker" instead of an empty graphic.
 */

export interface BuddyProps {
  signal?: MascotSignal;
  /** Overrides signal-driven state (used by overlays and tests). */
  state?: AnimationState;
  size?: number;
  reducedMotion?: boolean;
  /** Rotates the gaze toward a screen point, in -1..1 coordinates. */
  lookAt?: { x: number; y: number } | null;
  onStateChange?: (state: AnimationState) => void;
  className?: string;
}

export function Buddy({ signal, state: forcedState, size = 132, reducedMotion = false, lookAt, onStateChange, className }: BuddyProps) {
  const [controller, setController] = useState<MascotControllerState>(() => initialMascotState());
  const [blinkController, setBlinkController] = useState<MascotControllerState>(() => initialMascotState());
  const uid = useId().replace(/:/g, '');
  const reported = useRef<AnimationState | null>(null);

  // Signal -> state machine. Forced state (tests/storybook) wins over signals.
  useEffect(() => {
    if (forcedState) {
      setController((prev) => transition(prev, forcedState, { force: true }).state);
      return;
    }
    if (!signal) return;
    const next = signalToState(signal);
    setController((prev) => transition(prev, next).state);
  }, [signal, forcedState]);

  // Transient state expiry (blink/celebrate).
  useEffect(() => {
    if (controller.transientUntil === null) return;
    const ms = Math.max(0, controller.transientUntil - Date.now());
    const timer = setTimeout(() => setController((prev) => tick(prev)), ms + 10);
    return () => clearTimeout(timer);
  }, [controller.transientUntil]);

  // Natural blinking: a slow irregular rhythm while the mascot is calm.
  useEffect(() => {
    if (reducedMotion) return;
    if (controller.current === 'SLEEPING' || controller.current === 'SPEAKING') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = 2600 + Math.random() * 3800;
      timer = setTimeout(() => {
        if (cancelled) return;
        setBlinkController((prev) => transition(prev, 'BLINKING', { force: true, durationMs: 140 }).state);
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [controller.current, reducedMotion]);

  useEffect(() => {
    if (controller.transientUntil === null) return;
    const ms = Math.max(0, controller.transientUntil - Date.now());
    const timer = setTimeout(() => setBlinkController((prev) => tick(prev)), ms + 10);
    return () => clearTimeout(timer);
  }, [blinkController.transientUntil]);

  const effectiveState: AnimationState =
    blinkController.current === 'BLINKING' && !['SLEEPING', 'CELEBRATING'].includes(controller.current)
      ? 'BLINKING'
      : controller.current;

  useEffect(() => {
    if (reported.current === effectiveState) return;
    reported.current = effectiveState;
    onStateChange?.(effectiveState);
  }, [effectiveState, onStateChange]);

  const expression = EXPRESSIONS[effectiveState];
  const breathe = !reducedMotion && ['IDLE', 'BREATHING', 'SLEEPING', 'THINKING', 'CURIOUS'].includes(effectiveState);
  const bob = !reducedMotion && ['CELEBRATING', 'ENCOURAGING', 'POINTING'].includes(effectiveState);

  const gaze = useMemo(() => {
    if (!lookAt) return { x: expression.pupilX, y: expression.pupilY };
    return { x: expression.pupilX + lookAt.x * 5, y: expression.pupilY + lookAt.y * 4 };
  }, [lookAt, expression.pupilX, expression.pupilY]);

  return (
    <div className={className} style={{ width: size, height: size, position: 'relative', lineHeight: 0 }}>
      <style>{keyframes}</style>
      <svg
        viewBox="0 0 200 200"
        width={size}
        height={size}
        role="img"
        aria-hidden="true"
        style={{
          overflow: 'visible',
          filter: 'drop-shadow(0 6px 14px rgba(60,40,20,0.22))',
        }}
      >
        <defs>
          <radialGradient id={`fur-${uid}`} cx="38%" cy="28%" r="78%">
            <stop offset="0%" stopColor="#B98355" />
            <stop offset="55%" stopColor="#96633A" />
            <stop offset="100%" stopColor="#6E4425" />
          </radialGradient>
          <radialGradient id={`face-${uid}`} cx="45%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#FBEBD6" />
            <stop offset="100%" stopColor="#E8C9A2" />
          </radialGradient>
          <radialGradient id={`ear-${uid}`} cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="#E8C9A2" />
            <stop offset="100%" stopColor="#C99468" />
          </radialGradient>
          <linearGradient id={`shine-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>

        <g
          style={{
            transformOrigin: '100px 150px',
            animation: breathe ? 'buddy-breathe 3.6s ease-in-out infinite' : bob ? 'buddy-bob 1.1s ease-in-out infinite' : undefined,
          }}
        >
          {/* legs */}
          <ellipse cx="76" cy="168" rx="17" ry="12" fill="#6E4425" />
          <ellipse cx="124" cy="168" rx="17" ry="12" fill="#6E4425" />
          <ellipse cx="76" cy="170" rx="10" ry="6" fill="#C99468" opacity="0.8" />
          <ellipse cx="124" cy="170" rx="10" ry="6" fill="#C99468" opacity="0.8" />

          {/* tail */}
          <path
            d="M150 150 C 178 146, 184 120, 168 108 C 160 102, 152 108, 156 116"
            stroke="#6E4425"
            strokeWidth="9"
            strokeLinecap="round"
            fill="none"
            style={{ transformOrigin: '160px 140px', animation: reducedMotion ? undefined : 'buddy-tail 3.2s ease-in-out infinite' }}
          />

          {/* body */}
          <ellipse cx="100" cy="132" rx="42" ry="40" fill={`url(#fur-${uid})`} />
          <ellipse cx="100" cy="138" rx="26" ry="28" fill={`url(#face-${uid})`} opacity="0.95" />

          {/* arms */}
          <g style={{ transformOrigin: '62px 122px', animation: bob ? 'buddy-arm-left 0.9s ease-in-out infinite' : undefined }}>
            <ellipse cx="60" cy="126" rx="12" ry="20" fill="#7C4F2B" transform="rotate(-18 60 126)" />
            <circle cx="54" cy="144" r="9" fill="#C99468" />
          </g>
          <g style={{ transformOrigin: '140px 122px', animation: bob ? 'buddy-arm-right 0.9s ease-in-out infinite' : undefined }}>
            <ellipse cx="141" cy="126" rx="12" ry="20" fill="#7C4F2B" transform="rotate(18 141 126)" />
            <circle cx="147" cy="144" r="9" fill="#C99468" />
          </g>

          {/* ears */}
          <g style={{ transformOrigin: '100px 78px', transform: `rotate(${expression.headTilt}deg)` }}>
            <circle cx="42" cy="74" r="22" fill="#7C4F2B" />
            <circle cx="42" cy="74" r="13" fill={`url(#ear-${uid})`} />
            <circle cx="158" cy="74" r="22" fill="#7C4F2B" />
            <circle cx="158" cy="74" r="13" fill={`url(#ear-${uid})`} />

            {/* head */}
            <ellipse cx="100" cy="78" rx="54" ry="50" fill={`url(#fur-${uid})`} />
            {/* face patch */}
            <ellipse cx="100" cy="90" rx="38" ry="34" fill={`url(#face-${uid})`} />
            {/* forehead highlight */}
            <ellipse cx="100" cy="58" rx="30" ry="14" fill={`url(#shine-${uid})`} opacity="0.5" />

            {/* brows */}
            <rect x="68" y={62 - expression.browLift} width="24" height="5" rx="2.5" fill="#5A3A20" transform={`rotate(-6 80 ${64 - expression.browLift})`} />
            <rect x="108" y={62 - expression.browLift} width="24" height="5" rx="2.5" fill="#5A3A20" transform={`rotate(6 120 ${64 - expression.browLift})`} />

            {/* eyes */}
            <Eye cx={80} cy={80} open={expression.eyeOpen} pupilX={gaze.x} pupilY={gaze.y} />
            <Eye cx={120} cy={80} open={expression.eyeOpen} pupilX={gaze.x} pupilY={gaze.y} />

            {/* muzzle */}
            <ellipse cx="100" cy="106" rx="24" ry="18" fill="#FDF3E6" />
            <ellipse cx="92" cy="99" rx="2.6" ry="3.4" fill="#B98A63" />
            <ellipse cx="108" cy="99" rx="2.6" ry="3.4" fill="#B98A63" />

            {/* mouth */}
            <Mouth curve={expression.mouthCurve} open={expression.mouthOpen} speaking={effectiveState === 'SPEAKING'} reducedMotion={reducedMotion} />
          </g>
        </g>

        {/* thinking bubbles */}
        {effectiveState === 'THINKING' && !reducedMotion && (
          <g style={{ animation: 'buddy-pulse 1.4s ease-in-out infinite' }}>
            <circle cx="168" cy="52" r="5" fill="#F3E3CC" opacity="0.9" />
            <circle cx="178" cy="40" r="7" fill="#F3E3CC" opacity="0.75" />
            <circle cx="190" cy="26" r="9" fill="#F3E3CC" opacity="0.6" />
          </g>
        )}

        {/* sleeping z's */}
        {effectiveState === 'SLEEPING' && !reducedMotion && (
          <text x="160" y="34" fontSize="20" fill="#C9A57E" style={{ animation: 'buddy-zzz 3s ease-in-out infinite' }}>
            z
          </text>
        )}
      </svg>
      <span className="sr-only" role="status" aria-live="polite">
        {STATE_LABEL[effectiveState]}
      </span>
    </div>
  );
}

function Eye({ cx, cy, open, pupilX, pupilY }: { cx: number; cy: number; open: number; pupilX: number; pupilY: number }) {
  const height = 15 * Math.max(0.04, Math.min(1.15, open));
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx="10" ry={height} fill="#3B2A1C" />
      {open > 0.25 && (
        <>
          <circle cx={cx + pupilX} cy={cy + pupilY} r="6" fill="#1B120C" />
          <circle cx={cx + pupilX - 2.4} cy={cy + pupilY - 3} r="2.2" fill="#fff" opacity="0.9" />
        </>
      )}
      {/* eyelid line for closed eyes */}
      {open <= 0.25 && <path d={`M${cx - 11} ${cy} q 11 6 22 0`} stroke="#5A3A20" strokeWidth="2.4" fill="none" strokeLinecap="round" />}
    </g>
  );
}

function Mouth({ curve, open, speaking, reducedMotion }: { curve: number; open: number; speaking: boolean; reducedMotion: boolean }) {
  const smile = Math.max(-6, Math.min(8, curve * 8));
  const openness = Math.max(1.6, open * 9);
  return (
    <g>
      <path
        d={`M88 ${110} Q100 ${110 + smile * 1.6} 112 ${110}`}
        stroke="#8A5533"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      {open > 0.35 && (
        <ellipse
          cx="100"
          cy={114 + smile * 0.4}
          rx="7"
          ry={openness / 2}
          fill="#7A3B33"
          style={{ transformOrigin: '100px 112px', animation: speaking && !reducedMotion ? 'buddy-talk 0.34s ease-in-out infinite' : undefined }}
        />
      )}
    </g>
  );
}

const keyframes = `
@keyframes buddy-breathe { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-2px) scale(1.012); } }
@keyframes buddy-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes buddy-tail { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-7deg); } }
@keyframes buddy-arm-left { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-12deg); } }
@keyframes buddy-arm-right { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(12deg); } }
@keyframes buddy-pulse { 0%,100% { opacity: 0.45; } 50% { opacity: 1; } }
@keyframes buddy-zzz { 0% { opacity: 0; transform: translateY(4px); } 50% { opacity: 1; } 100% { opacity: 0; transform: translateY(-8px); } }
@keyframes buddy-talk { 0%,100% { transform: scaleY(0.7); } 50% { transform: scaleY(1.15); } }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; }
}
`;

function signalToState(signal: MascotSignal): AnimationState {
  switch (signal) {
    case 'app-idle':
      return 'BREATHING';
    case 'user-typing':
      return 'CURIOUS';
    case 'message-sent':
      return 'THINKING';
    case 'streaming-started':
      return 'WRITING';
    case 'voice-listening':
      return 'LISTENING';
    case 'voice-speaking':
      return 'SPEAKING';
    case 'answer-delivered':
      return 'IDLE';
    case 'answer-correct':
      return 'CELEBRATING';
    case 'answer-wrong':
      return 'ENCOURAGING';
    case 'hint-shown':
      return 'CURIOUS';
    case 'pointing-at-target':
      return 'POINTING';
    case 'blink':
      return 'BLINKING';
    case 'long-inactivity':
      return 'SLEEPING';
    case 'error':
      return 'CONFUSED';
  }
}
