import { useEffect, useState } from 'react';
import type { AnimationState, MascotSignal } from './states.js';

export interface BuddyProps {
  signal?: MascotSignal;
  state?: AnimationState;
  size?: number;
  reducedMotion?: boolean;
  studyLive?: boolean;
  lookAt?: { x: number; y: number } | null;
  onStateChange?: (state: AnimationState) => void;
  className?: string;
}

/**
 * An original orange pixel companion (NOT a monkey or borrowed brand sprite).
 * Every face is drawn from integer pixel shapes and animates independently.
 */
export function Buddy({
  signal, state, size = 132, reducedMotion = false,
  studyLive = false, lookAt, onStateChange, className,
}: BuddyProps) {
  const [blink, setBlink] = useState(false);
  const [ambient, setAmbient] = useState({ x: 0, y: 0 });
  const [listeningPulse, setListeningPulse] = useState(false);
  const mood: AnimationState = state ?? (
    signal === 'message-sent' ? 'THINKING' :
    signal === 'user-typing' ? 'CURIOUS' :
    signal === 'voice-speaking' ? 'SPEAKING' :
    signal === 'voice-listening' ? 'LISTENING' :
    signal === 'answer-correct' ? 'CELEBRATING' :
    signal === 'answer-wrong' || signal === 'error' ? 'CONFUSED' :
    signal === 'long-inactivity' ? 'SLEEPING' :
    signal === 'hint-shown' ? 'POINTING' :
    'IDLE'
  );

  useEffect(() => {
    onStateChange?.(mood);
  }, [mood, onStateChange]);

  useEffect(() => {
    if (reducedMotion) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        setBlink(true);
        timer = setTimeout(() => {
          if (!alive) return;
          setBlink(false);
          next();
        }, 145);
      }, 2400 + Math.random() * 4200);
    };
    next();
    return () => { alive = false; clearTimeout(timer); };
  }, [reducedMotion]);

  useEffect(() => {
    if (reducedMotion || lookAt) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const move = () => {
      if (!alive) return;
      setAmbient({
        x: Math.round((Math.random() - .5) * 4),
        y: Math.round((Math.random() - .5) * 3),
      });
      timer = setTimeout(move, 1800 + Math.random() * 2300);
    };
    move();
    return () => { alive = false; clearTimeout(timer); };
  }, [lookAt, reducedMotion]);

  useEffect(() => {
    if (reducedMotion || mood !== 'LISTENING') return;
    const timer = setInterval(() => setListeningPulse(value => !value), 350);
    return () => clearInterval(timer);
  }, [mood, reducedMotion]);

  const dx = lookAt ? Math.round(Math.max(-2, Math.min(2, lookAt.x * 2))) : ambient.x;
  const dy = lookAt ? Math.round(Math.max(-2, Math.min(2, lookAt.y * 2))) : ambient.y;
  const sleeping = mood === 'SLEEPING';
  const thinking = mood === 'THINKING';
  const happy = mood === 'CELEBRATING';
  const curious = mood === 'CURIOUS' || mood === 'POINTING';
  const talking = mood === 'SPEAKING';
  const eyesClosed = blink || sleeping;
  const pixelOrange = '#E7784D';
  const ink = '#322639';

  return (
    <div className={className}
      role="img"
      aria-label={studyLive ? 'Buddy: grön puls, studiefönster observeras' : 'Buddy: redo, observerar ingen skärm'}
      style={{
        width: size, height: size, position: 'relative',
        animation: reducedMotion ? undefined : 'buddyFloat 4.8s ease-in-out infinite',
        filter: 'drop-shadow(0 8px 5px rgba(0,0,0,.28))',
      }}
    >
      <style>{`
@keyframes buddyFloat { 0%,100% { transform:translateY(0) rotate(-1deg) } 35% { transform:translateY(-5px) rotate(1.8deg) } 75% { transform:translateY(2px) rotate(-.5deg) } }
@keyframes buddyHand { 0%,100% { transform:rotate(0) } 50% { transform:rotate(17deg) } }
@keyframes buddySpark { 0%,100% { opacity:.4; transform:scale(.85) } 50% { opacity:1; transform:scale(1.12) } }
@keyframes buddyGreen { 0%,100% { opacity:.4; filter:drop-shadow(0 0 2px #41ff90) } 50% { opacity:1; filter:drop-shadow(0 0 9px #41ff90) } }
@keyframes buddyTalk { 0%,100% { transform:scaleY(.65) } 50% { transform:scaleY(1.25) } }
@media (prefers-reduced-motion:reduce) { .buddy-pixel * { animation:none!important } }
`}</style>
      <svg className="buddy-pixel" viewBox="0 0 96 96"
        width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
        <ellipse cx="48" cy="89" rx="29" ry="4" fill="#322639" opacity=".24"/>
        {/* original six-legged orange pixel creature, NOT a monkey */}
        <g style={{ transformOrigin: '48px 54px', animation: reducedMotion ? undefined : 'buddyFloat 5.7s ease-in-out infinite' }}>
          <path d="M24 14h48v7h9v9h8v43h-8v8h-7v9h-9V78h-8v12h-8V78h-8v12h-8V78h-8v12h-9V79h-8v-9H7V31h8v-9h9z" fill={ink}/>
          <path d="M25 18h46v8h9v8h6v34h-9v8h-7v10h-4V74H54v12h-4V74H39v12h-4V74H24v12h-4V75h-8v-9H10V35h8v-8h7z" fill={pixelOrange}/>
          <path d="M26 21h37v7H22v12h-8v-7h8v-6h4z" fill="#F49A69"/>
          <path d="M70 28h8v13h7v21h-6V42h-9z" fill="#CD5C3C"/>
          <path d="M28 65h42v5H28z" fill="#DD6B47"/>
          {/* eyebrows react to question context */}
          {curious && <><rect x="27" y="39" width="15" height="3" fill="#7F3C39" transform="rotate(-8 34 39)"/><rect x="55" y="39" width="15" height="3" fill="#7F3C39" transform="rotate(8 62 39)"/></>}
          {/* eyes track the cursor and glance around while idle */}
          {eyesClosed ? (
            <><rect x="29" y="48" width="13" height="3" fill={ink}/><rect x="56" y="48" width="13" height="3" fill={ink}/></>
          ) : (
            <>
              <rect x={30 + dx} y={44 + dy} width="9" height="11" fill={ink}/>
              <rect x={57 + dx} y={44 + dy} width="9" height="11" fill={ink}/>
              <rect x={31 + dx} y={45 + dy} width="3" height="3" fill="#FFF9EC"/>
              <rect x={58 + dx} y={45 + dy} width="3" height="3" fill="#FFF9EC"/>
            </>
          )}
          {/* simple pixel mouth, no static pasted face */}
          {happy ? <path d="M40 60v3h4v3h9v-3h4v-3" fill="none" stroke={ink} strokeWidth="3"/> :
            talking ? <rect x="45" y="61" width="8" height="6" rx="1" fill={ink} style={{ transformOrigin: '49px 64px', animation: reducedMotion ? undefined : 'buddyTalk .32s ease-in-out infinite' }}/> :
            <rect x="44" y="62" width="10" height="3" fill={ink}/>}
          {/* reaction paws */}
          {curious && <g style={{ transformOrigin: '78px 37px', animation: reducedMotion ? undefined : 'buddyHand .85s ease-in-out infinite' }}>
            <rect x="80" y="28" width="6" height="14" fill={pixelOrange}/>
            <rect x="85" y="26" width="6" height="6" fill="#F49A69"/>
          </g>}
        </g>
        {thinking && <g style={{ animation: reducedMotion ? undefined : 'buddySpark 1.1s ease-in-out infinite' }}>
          <rect x="79" y="10" width="5" height="5" fill="#FFCA80"/>
          <rect x="88" y="2" width="4" height="4" fill="#FFCA80"/>
        </g>}
        {mood === 'LISTENING' && <rect x="83" y="12" width={listeningPulse ? 8 : 5} height={listeningPulse ? 8 : 5} fill="#83D9F6"/>}
        {studyLive && <g style={{ animation: reducedMotion ? undefined : 'buddyGreen 1.25s ease-in-out infinite' }}>
          <rect x="76" y="73" width="17" height="17" fill={ink}/>
          <rect x="79" y="76" width="11" height="11" fill="#32F27E"/>
          <rect x="81" y="78" width="4" height="4" fill="#DBFFE9"/>
        </g>}
      </svg>
    </div>
  );
}
