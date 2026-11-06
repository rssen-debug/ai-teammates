/**
 * Buddy's animation states and the rules for moving between them.
 *
 * This is a deterministic state machine with priorities, so a stray "blink"
 * can never interrupt "speaking", and the mascot never flickers between states
 * because two subsystems disagree. UI code calls `transition()`, never sets a
 * state directly.
 */

export const ANIMATION_STATES = [
  'IDLE',
  'BREATHING',
  'BLINKING',
  'CURIOUS',
  'LISTENING',
  'THINKING',
  'WRITING',
  'SPEAKING',
  'POINTING',
  'ENCOURAGING',
  'CELEBRATING',
  'CONFUSED',
  'SLEEPING',
] as const;

export type AnimationState = (typeof ANIMATION_STATES)[number];

/** Higher number wins. Used to decide whether a new state may interrupt. */
export const STATE_PRIORITY: Record<AnimationState, number> = {
  SLEEPING: 0,
  IDLE: 1,
  BREATHING: 1,
  BLINKING: 2,
  CURIOUS: 3,
  LISTENING: 4,
  POINTING: 4,
  THINKING: 5,
  WRITING: 5,
  CONFUSED: 5,
  SPEAKING: 6,
  ENCOURAGING: 6,
  CELEBRATING: 7,
};

/** States that are visual overlays on top of a base state and expire. */
export const TRANSIENT_STATES: AnimationState[] = ['BLINKING', 'CELEBRATING', 'ENCOURAGING'];

/** Base states that transient overlays must not interrupt. */
export const TRANSIENT_LOCKED: AnimationState[] = ['SPEAKING', 'CELEBRATING', 'POINTING', 'SLEEPING'];

export interface MascotControllerState {
  base: AnimationState;
  current: AnimationState;
  /** ms since epoch when the transient state should end. */
  transientUntil: number | null;
}

export interface TransitionOptions {
  now?: number;
  /** Force the change even if priority says no (used for explicit user actions). */
  force?: boolean;
  /** How long a transient state lasts. */
  durationMs?: number;
}

export const DEFAULT_TRANSIENT_MS: Partial<Record<AnimationState, number>> = {
  BLINKING: 160,
  CELEBRATING: 1800,
  ENCOURAGING: 1400,
};

export function initialMascotState(): MascotControllerState {
  return { base: 'IDLE', current: 'IDLE', transientUntil: null };
}

/**
 * Applies a new state. Returns the next controller state plus whether the
 * request was accepted (so callers/tests can see rejections instead of guessing).
 */
export function transition(
  state: MascotControllerState,
  next: AnimationState,
  options: TransitionOptions = {},
): { state: MascotControllerState; accepted: boolean } {
  const now = options.now ?? Date.now();

  // Expire a finished transient state first.
  const expired =
    state.transientUntil !== null && now >= state.transientUntil
      ? { ...state, current: state.base, transientUntil: null }
      : state;

  if (TRANSIENT_STATES.includes(next)) {
    const duration = options.durationMs ?? DEFAULT_TRANSIENT_MS[next] ?? 500;
    // Transients are overlays: reading a page while blinking, or blinking while
    // thinking, are both normal. They are only blocked when the mascot is in an
    // engaged state where an interruption would read as a glitch.
    const allowed = options.force || !TRANSIENT_LOCKED.includes(expired.base);
    if (!allowed) return { state: expired, accepted: false };
    return {
      state: {
        base: expired.base,
        current: next,
        transientUntil: now + duration,
      },
      accepted: true,
    };
  }

  // Persistent state change.
  const allowed = options.force || STATE_PRIORITY[next] >= STATE_PRIORITY[expired.current];
  if (!allowed) return { state: expired, accepted: false };

  // Listening/thinking etc. replace the base; a base of IDLE is the resting point.
  return {
    state: { base: next, current: next, transientUntil: null },
    accepted: true,
  };
}

/** Ticks the controller: expires transient states. Call from a render timer. */
export function tick(state: MascotControllerState, now = Date.now()): MascotControllerState {
  if (state.transientUntil === null || now < state.transientUntil) return state;
  return { ...state, current: state.base, transientUntil: null };
}

/**
 * Maps application signals to animation states. Keeping this mapping in one
 * place is what stops the mascot from "randomly" reacting: every animation has
 * an explicit cause.
 */
export type MascotSignal =
  | 'app-idle'
  | 'user-typing'
  | 'message-sent'
  | 'streaming-started'
  | 'voice-listening'
  | 'voice-speaking'
  | 'answer-delivered'
  | 'answer-correct'
  | 'answer-wrong'
  | 'hint-shown'
  | 'pointing-at-target'
  | 'blink'
  | 'long-inactivity'
  | 'error';

export const SIGNAL_TO_STATE: Record<MascotSignal, AnimationState> = {
  'app-idle': 'BREATHING',
  'user-typing': 'CURIOUS',
  'message-sent': 'THINKING',
  'streaming-started': 'WRITING',
  'voice-listening': 'LISTENING',
  'voice-speaking': 'SPEAKING',
  'answer-delivered': 'IDLE',
  'answer-correct': 'CELEBRATING',
  'answer-wrong': 'ENCOURAGING',
  'hint-shown': 'CURIOUS',
  'pointing-at-target': 'POINTING',
  blink: 'BLINKING',
  'long-inactivity': 'SLEEPING',
  error: 'CONFUSED',
};

export function stateForSignal(signal: MascotSignal): AnimationState {
  return SIGNAL_TO_STATE[signal];
}

/** Accessible description per state, announced to screen readers politely. */
export const STATE_LABEL: Record<AnimationState, string> = {
  IDLE: 'Buddy vilar',
  BREATHING: 'Buddy vilar',
  BLINKING: 'Buddy blinkar',
  CURIOUS: 'Buddy lyssnar nyfiket',
  LISTENING: 'Buddy lyssnar på dig',
  THINKING: 'Buddy tänker',
  WRITING: 'Buddy skriver',
  SPEAKING: 'Buddy talar',
  POINTING: 'Buddy pekar på skärmen',
  ENCOURAGING: 'Buddy uppmuntrar dig',
  CELEBRATING: 'Buddy firar',
  CONFUSED: 'Buddy är förvirrad',
  SLEEPING: 'Buddy sover',
};

/** Facial expression per state, consumed by the SVG renderer. */
export interface Expression {
  /** Eye openness 0..1 (1 = fully open). */
  eyeOpen: number;
  /** Pupil offset in local SVG units. */
  pupilX: number;
  pupilY: number;
  /** Mouth curve: -1 frown .. 1 smile. */
  mouthCurve: number;
  mouthOpen: number;
  browLift: number;
  /** Head tilt in degrees. */
  headTilt: number;
  /** Ear/arm energy 0..1 for secondary motion. */
  energy: number;
}

export const EXPRESSIONS: Record<AnimationState, Expression> = {
  IDLE: { eyeOpen: 1, pupilX: 0, pupilY: 0, mouthCurve: 0.45, mouthOpen: 0.1, browLift: 0, headTilt: 0, energy: 0.2 },
  BREATHING: { eyeOpen: 1, pupilX: 0, pupilY: 1, mouthCurve: 0.5, mouthOpen: 0.08, browLift: 0, headTilt: 1, energy: 0.15 },
  BLINKING: { eyeOpen: 0.05, pupilX: 0, pupilY: 0, mouthCurve: 0.45, mouthOpen: 0.1, browLift: 0, headTilt: 0, energy: 0.1 },
  CURIOUS: { eyeOpen: 1.1, pupilX: 3, pupilY: -2, mouthCurve: 0.55, mouthOpen: 0.2, browLift: 3, headTilt: -7, energy: 0.5 },
  LISTENING: { eyeOpen: 1.05, pupilX: -2, pupilY: 1, mouthCurve: 0.4, mouthOpen: 0.12, browLift: 2, headTilt: 4, energy: 0.4 },
  THINKING: { eyeOpen: 0.85, pupilX: 4, pupilY: -4, mouthCurve: 0.1, mouthOpen: 0.05, browLift: -2, headTilt: 6, energy: 0.3 },
  WRITING: { eyeOpen: 0.9, pupilX: 1, pupilY: 3, mouthCurve: 0.3, mouthOpen: 0.08, browLift: 0, headTilt: 3, energy: 0.6 },
  SPEAKING: { eyeOpen: 1, pupilX: 0, pupilY: 0, mouthCurve: 0.5, mouthOpen: 0.75, browLift: 1, headTilt: 0, energy: 0.7 },
  POINTING: { eyeOpen: 1, pupilX: 5, pupilY: -1, mouthCurve: 0.5, mouthOpen: 0.25, browLift: 2, headTilt: -4, energy: 0.8 },
  ENCOURAGING: { eyeOpen: 0.85, pupilX: 0, pupilY: 0, mouthCurve: 0.9, mouthOpen: 0.3, browLift: 3, headTilt: -3, energy: 0.65 },
  CELEBRATING: { eyeOpen: 0.7, pupilX: 0, pupilY: -1, mouthCurve: 1, mouthOpen: 0.6, browLift: 5, headTilt: 0, energy: 1 },
  CONFUSED: { eyeOpen: 0.95, pupilX: -4, pupilY: 2, mouthCurve: -0.35, mouthOpen: 0.15, browLift: 4, headTilt: 9, energy: 0.35 },
  SLEEPING: { eyeOpen: 0.02, pupilX: 0, pupilY: 0, mouthCurve: 0.2, mouthOpen: 0.12, browLift: -3, headTilt: 8, energy: 0.05 },
};
