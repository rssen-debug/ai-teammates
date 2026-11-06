import { useEffect, useMemo, useRef, useState } from 'react';
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
        viewBox="0 0 160 160"
        width={size}
        height={size}
        shapeRendering="crispEdges"
        aria-hidden="true"
        style={{
          overflow: 'visible',
          filter: 'drop-shadow(0 7px 2px rgba(25, 17, 30, 0.22))',
        }}
      >
        {/* Each silhouette is constructed out of grid-aligned pixels: this is
            an original, animated pixel character, not a sprite stock image. */}
        <ellipse cx="81" cy="148" rx="39" ry="5" fill="#202434" opacity=".18" />
        <g style={{
          transformOrigin: '80px 125px',
          animation: breathe ? 'buddy-breathe 3.6s ease-in-out infinite' : bob ? 'buddy-bob 1.1s ease-in-out infinite' : undefined,
        }}>
          {/* curly pixel tail */}
          <g style={{ transformOrigin: '122px 116px', animation: reducedMotion ? undefined : 'buddy-tail 3.2s ease-in-out infinite' }}>
            <path d="M116 108h13v-7h8V89h8v-14h-8v-8h-9v8h-8v8h8v8h-8v7h-12z" fill="#30263C"/>
            <path d="M120 108h9v-7h8V89h8v-14h-8v14h-8v12h-9z" fill="#A36B57"/>
          </g>
          {/* feet */}
          <path d="M49 130h27v8h-5v8H42v-8h7zM88 130h27v8h7v8H92v-8h-4z" fill="#30263C"/>
          <path d="M47 138h25v6H47zM94 138h25v6H94z" fill="#C69074"/>
          {/* body */}
          <path d="M56 98h48v7h12v13h7v13h-8v9H47v-9h-7v-13h8v-13h8z" fill="#30263C"/>
          <path d="M57 100h46v8h12v14h6v8h-8v8H49v-8h-7v-10h8v-12h7z" fill="#A66E55"/>
          <path d="M62 105h36v5h9v18h-9v8H62v-8h-8v-18h8z" fill="#D7A27D"/>
          <path d="M70 115h21v17H70z" fill="#F5CC9F"/>
          {/* pixel arms, gentle wave when encouraging */}
          <g style={{ transformOrigin: '48px 108px', animation: bob ? 'buddy-arm-left 0.9s ease-in-out infinite' : undefined }}>
            <path d="M48 108h-9v6h-8v21h8v8h10v-8h5v-22h-6z" fill="#30263C"/>
            <path d="M42 112h7v19h-5v8h-8v-7h-3v-14h9z" fill="#B57B5E"/>
            <path d="M34 134h12v7H34z" fill="#F0BD92"/>
          </g>
          <g style={{ transformOrigin: '112px 108px', animation: bob ? 'buddy-arm-right 0.9s ease-in-out infinite' : undefined }}>
            <path d="M112 108h9v6h8v21h-8v8h-10v-8h-5v-22h6z" fill="#30263C"/>
            <path d="M111 112h7v6h9v14h-3v7h-8v-8h-5z" fill="#B57B5E"/>
            <path d="M114 134h12v7h-12z" fill="#F0BD92"/>
          </g>
          {/* head: tiny movements express listening and thinking */}
          <g style={{ transformOrigin: '80px 75px', transform: 'rotate(' + expression.headTilt + 'deg)', transition: reducedMotion ? undefined : 'transform 260ms ease-out' }}>
            {/* ears */}
            <path d="M18 52h21v-8h13v36H39v-7H18zM121 44h13v8h19v21h-19v7h-13z" fill="#30263C"/>
            <path d="M22 55h19v-7h7v27h-9v-7H22zM122 48h9v7h18v13h-18v7h-9z" fill="#B47D63"/>
            <path d="M27 59h16v11H27zM125 59h19v11h-19z" fill="#E8AF8A"/>
            {/* stepped pixel head */}
            <path d="M57 22h46v7h14v8h10v12h8v36h-8v14h-9v10h-12v7H54v-7H42V99h-9V85h-8V49h8V37h10v-8h14z" fill="#30263C"/>
            <path d="M59 26h43v7h14v8h9v12h6v29h-7v14h-9v9h-11v7H56v-7H45v-9h-9V82h-7V52h7V41h9v-8h14z" fill="#A96D56"/>
            {/* pixel fur lighting */}
            <path d="M54 34h39v7H52v10h-8v16h-7V53h7V41h10z" fill="#C18C69"/>
            <path d="M104 39h11v13h8v31h-7V56h-12z" fill="#845044"/>
            <path d="M54 72h9V57h34v8h14v10h12v19h-8v12H49V94h-9V77h14z" fill="#E1AD87"/>
            <path d="M61 82h41v7h10v14h-9v8H59v-8H50V89h11z" fill="#F7D3A7"/>
            {/* expressive pixel brows */}
            <path d="M51 62h22v4H51zM88 62h22v4H88z" fill="#573744" transform={'translate(0 ' + (-expression.browLift) + ')'} />
            {/* large crisp pixel eyes with animated blink and pupil movement */}
            <PixelEye x={54} y={70} open={expression.eyeOpen} dx={gaze.x} dy={gaze.y}/>
            <PixelEye x={90} y={70} open={expression.eyeOpen} dx={gaze.x} dy={gaze.y}/>
            {/* nose and softly animated mouth */}
            <rect x="77" y="92" width="7" height="5" fill="#AA7466"/>
            <PixelMouth open={expression.mouthOpen} curve={expression.mouthCurve} speaking={effectiveState === 'SPEAKING'} reducedMotion={reducedMotion}/>
            {/* little freckles */}
            <rect x="51" y="98" width="4" height="3" fill="#DFA083"/>
            <rect x="106" y="98" width="4" height="3" fill="#DFA083"/>
          </g>
        </g>
        {effectiveState === 'THINKING' && !reducedMotion && (
          <g style={{ animation: 'buddy-pulse 1.4s ease-in-out infinite' }}>
            <rect x="130" y="30" width="5" height="5" fill="#91DECF"/>
            <rect x="141" y="18" width="8" height="8" fill="#91DECF"/>
            <rect x="153" y="5" width="5" height="5" fill="#91DECF"/>
          </g>
        )}
        {effectiveState === 'SLEEPING' && !reducedMotion && (
          <text x="133" y="22" fill="#C6EDE0" fontFamily="monospace" fontSize="17" fontWeight="bold" style={{ animation: 'buddy-zzz 3s ease-in-out infinite' }}>z</text>
        )}
        {effectiveState === 'CELEBRATING' && !reducedMotion && (
          <g style={{ animation: 'buddy-pulse 0.9s ease-in-out infinite' }}>
            <rect x="19" y="21" width="7" height="7" fill="#F1CB72"/>
            <rect x="132" y="28" width="7" height="7" fill="#91DECF"/>
            <rect x="141" y="11" width="4" height="4" fill="#F1CB72"/>
          </g>
        )}
      </svg></svg>
      <span className="sr-only" role="status" aria-live="polite">
        {STATE_LABEL[effectiveState]}
      </span>
    </div>
  );
}

function PixelEye({ x, y, open, dx, dy }: { x: number; y: number; open: number; dx: number; dy: number }) {
  if (open <= 0.25) return <path d={'M' + x + ' ' + (y + 9) + 'h20v3h-20z'} fill="#503745"/>;
  const shiftX = Math.round(Math.max(-2, Math.min(2, dx)));
  const shiftY = Math.round(Math.max(-2, Math.min(2, dy)));
  return (
    <g>
      <rect x={x} y={y} width="20" height="20" fill="#382A3E"/>
      <rect x={x + 2} y={y + 2} width="16" height="16" fill="#FFF4E5"/>
      <rect x={x + 6 + shiftX} y={y + 6 + shiftY} width="10" height="10" fill="#242535"/>
      <rect x={x + 7 + shiftX} y={y + 7 + shiftY} width="4" height="4" fill="#FFFFFF"/>
    </g>
  );
}

function PixelMouth({ open, curve, speaking, reducedMotion }: { open: number; curve: number; speaking: boolean; reducedMotion: boolean }) {
  if (speaking || open > 0.5) {
    return <rect x="74" y="100" width="13" height={Math.max(4, Math.round(open * 10))} fill="#573744"
      style={{ transformOrigin: '80px 102px', animation: speaking && !reducedMotion ? 'buddy-talk 0.34s ease-in-out infinite' : undefined }} />;
  }
  return <path d={curve < -0.1 ? 'M73 110h5v-4h8v4h5' : 'M71 103h5v4h9v-4h5'} fill="none" stroke="#573744" strokeWidth="3" />;
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
