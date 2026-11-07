/**
 * MAJIN spirit — one living orb.
 *
 * Canvas 2D only: no WebGL context loss, no 3D dependency, and it degrades to
 * a static gradient when the user prefers reduced motion or the device is slow.
 * The orb is an indicator, not decoration: its state is bound to the real
 * conversation state machine.
 */

const PALETTE = {
  idle: { a: '#ff6fc8', b: '#8b5cf6', c: '#2a1554', glow: 'rgba(255,79,184,0.35)' },
  listening: { a: '#ff8ad4', b: '#a78bfa', c: '#3a1a6b', glow: 'rgba(255,120,200,0.5)' },
  thinking: { a: '#c084fc', b: '#6366f1', c: '#241452', glow: 'rgba(168,85,247,0.4)' },
  working: { a: '#ff4fb8', b: '#7c3aed', c: '#2b1060', glow: 'rgba(255,79,184,0.45)' },
  speaking: { a: '#ffd1f0', b: '#ff4fb8', c: '#43166b', glow: 'rgba(255,140,220,0.55)' },
  done: { a: '#a7f3d0', b: '#4ade80', c: '#0f3d2b', glow: 'rgba(74,222,128,0.4)' },
  error: { a: '#fda4af', b: '#fb7185', c: '#3f1220', glow: 'rgba(251,113,133,0.45)' },
};

const SPEED = { idle: 0.35, listening: 1.1, thinking: 1.6, working: 1.25, speaking: 0.9, done: 1.4, error: 0.5 };
const PULSE = { idle: 0.035, listening: 0.09, thinking: 0.04, working: 0.06, speaking: 0.12, done: 0.14, error: 0.02 };

export function createSpirit(canvas, { reducedMotion = false, lowPower = false } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return { set() {}, level() {}, destroy() {}, resize() {} };

  const dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.5 : 2);
  let cssSize = 320;
  let state = 'idle';
  let raf = null;
  let t0 = performance.now();
  let level = 0;          // microphone / speech energy, 0..1
  let targetLevel = 0;
  let doneUntil = 0;
  const particles = Array.from({ length: lowPower ? 14 : 26 }, (_, i) => ({
    angle: (i / 26) * Math.PI * 2 + Math.random(),
    radius: 0.62 + Math.random() * 0.36,
    speed: 0.12 + Math.random() * 0.4,
    size: 0.8 + Math.random() * 1.8,
    phase: Math.random() * Math.PI * 2,
  }));

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssSize = Math.max(60, Math.round(rect.width || 320));
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    if (reducedMotion) draw(performance.now(), true);
  }

  function currentState(now) {
    if (state === 'done' && now > doneUntil) return 'idle';
    return state;
  }

  function draw(now, still = false) {
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const st = currentState(now);
    const pal = PALETTE[st] || PALETTE.idle;
    const t = (now - t0) / 1000;
    level += (targetLevel - level) * (still ? 1 : 0.12);

    ctx.clearRect(0, 0, size, size);

    const breathe = still ? 0 : Math.sin(t * (0.6 + SPEED[st] * 0.5)) * PULSE[st];
    const base = size * 0.3 * (1 + breathe + level * 0.1);

    // outer halo
    const halo = ctx.createRadialGradient(cx, cy, base * 0.5, cx, cy, base * 2.05);
    halo.addColorStop(0, pal.glow);
    halo.addColorStop(0.55, pal.glow.replace(/[\d.]+\)$/, '0.10)'));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, base * 2.05, 0, Math.PI * 2);
    ctx.fill();

    // rotating energy arcs
    const arcs = lowPower ? 1 : 3;
    for (let i = 0; i < arcs; i += 1) {
      const r = base * (1.28 + i * 0.16);
      const spin = still ? 0 : t * SPEED[st] * (0.5 + i * 0.3);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin + i * 2.1);
      ctx.strokeStyle = i === 0 ? pal.a : pal.b;
      ctx.globalAlpha = 0.42 - i * 0.11;
      ctx.lineWidth = Math.max(1, size * 0.004);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0.2, 1.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r, Math.PI + 0.4, Math.PI + 1.15);
      ctx.globalAlpha *= 0.6;
      ctx.stroke();
      ctx.restore();
    }

    // particles on elliptical orbits
    if (!lowPower) {
      for (const p of particles) {
        const ang = p.angle + (still ? 0 : t * p.speed * SPEED[st]);
        const wobble = 1 + Math.sin(t * 1.4 + p.phase) * 0.04 + level * 0.12;
        const x = cx + Math.cos(ang) * base * 1.5 * p.radius * wobble;
        const y = cy + Math.sin(ang) * base * 1.5 * p.radius * wobble * 0.92;
        ctx.globalAlpha = 0.25 + 0.45 * Math.abs(Math.sin(t * 0.9 + p.phase));
        ctx.fillStyle = p.size > 1.8 ? pal.a : pal.b;
        ctx.beginPath();
        ctx.arc(x, y, p.size * (size / 320), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // core
    const core = ctx.createRadialGradient(cx - base * 0.22, cy - base * 0.26, base * 0.05, cx, cy, base);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.16, pal.a);
    core.addColorStop(0.62, pal.b);
    core.addColorStop(1, pal.c);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, base, 0, Math.PI * 2);
    ctx.fill();

    // inner light
    const sheen = ctx.createRadialGradient(cx - base * 0.3, cy - base * 0.34, 0, cx - base * 0.3, cy - base * 0.34, base * 0.9);
    sheen.addColorStop(0, 'rgba(255,255,255,0.55)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.arc(cx, cy, base, 0, Math.PI * 2);
    ctx.fill();

    // rim
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(1, size * 0.0025);
    ctx.beginPath();
    ctx.arc(cx, cy, base, 0, Math.PI * 2);
    ctx.stroke();
  }

  function frame(now) {
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf != null || reducedMotion) return;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
  }

  resize();
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });
  if (reducedMotion) draw(performance.now(), true);
  else start();

  return {
    set(next) {
      if (!PALETTE[next] || next === state) {
        if (next === 'done') doneUntil = performance.now() + 1600;
        return;
      }
      state = next;
      document.body.dataset.spirit = next;
      if (next === 'done') doneUntil = performance.now() + 1600;
      if (reducedMotion) draw(performance.now(), true);
    },
    level(v) {
      targetLevel = Math.max(0, Math.min(1, Number(v) || 0));
    },
    resize,
    destroy() {
      stop();
      window.removeEventListener('resize', resize);
    },
    get state() {
      return state;
    },
  };
}
