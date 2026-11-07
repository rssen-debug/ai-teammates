/**
 * MAJIN V5 — 99-Dot Matrix Motif & Progression Renderer (Section 6).
 *
 * Rules enforced here:
 *  - Exactly 99 distinct dots/segments (3 concentric rings of 33 = 99).
 *  - Green segments (`1..level`) reflect ONLY verified skill level (1–99).
 *  - Level 99 activates a cohesive radiant green mastery ring (`cohesiveMastery: true`).
 *  - Activity (`activity: 'working'`) is visually distinct from verified learning
 *    (`learning: true`): working activity never lights up green XP segments.
 *  - Numeric level (`18/99`) and text status (`VERIFIED`, `STALE`, `MASTERED`)
 *    always accompany the visual motif so color is never the only signal.
 */

export const TOTAL_SKILL_DOTS = 99;

/**
 * Pure computation of the 99-dot matrix state from real skill data.
 * Used both by the Canvas/DOM renderer and by automated verification tests.
 */
export function computeDotMatrixState({
  skillId = 'aggregate',
  displayName = 'Formulär', // input vocabulary, never rendered
  level = 1,
  xp = 0,
  lastXpGain = 0,
  freshness = 'FRESH',
  maturityStatus = 'UNTRAINED',
  activity = 'idle', // 'idle' | 'working'
} = {}) {
  const clampedLevel = Math.max(1, Math.min(TOTAL_SKILL_DOTS, Math.floor(Number(level) || 1)));
  const isLevel99 = clampedLevel === TOTAL_SKILL_DOTS && freshness === 'FRESH';
  const isStale = freshness === 'STALE' || maturityStatus === 'STALE';
  const isWorking = activity === 'working';

  const dots = Array.from({ length: TOTAL_SKILL_DOTS }, (_, idx) => {
    const dotNumber = idx + 1;
    const ringIndex = Math.floor(idx / 33); // 0, 1, 2 (33 dots each = 99)
    const filled = dotNumber <= clampedLevel;
    let color = 'rgba(255, 255, 255, 0.12)';
    let state = 'untrained';
    if (filled) {
      if (isLevel99) {
        color = '#10b981'; // Cohesive Level 99 emerald accent
        state = 'mastered-99';
      } else if (isStale) {
        color = '#f59e0b'; // Historical level preserved, amber STALE warning
        state = 'verified-stale';
      } else {
        color = '#22c55e'; // Verified green progression
        state = 'verified-active';
      }
    }
    return {
      index: dotNumber,
      ring: ringIndex,
      filled,
      state,
      color,
    };
  });

  const tickerText = formatXpTicker({
    displayName,
    level: clampedLevel,
    xpGain: lastXpGain,
    freshness: isStale ? 'STALE' : freshness,
  });

  return {
    skillId,
    displayName,
    totalDots: TOTAL_SKILL_DOTS,
    greenDotsCount: clampedLevel,
    unfilledDotsCount: TOTAL_SKILL_DOTS - clampedLevel,
    level: clampedLevel,
    maxLevel: TOTAL_SKILL_DOTS,
    xp: Math.max(0, Number(xp) || 0),
    lastXpGain: Math.max(0, Number(lastXpGain) || 0),
    cohesiveMastery99: isLevel99,
    isStale,
    maturityStatus: isStale ? 'STALE' : maturityStatus,
    activityState: isWorking ? 'working' : 'idle',
    // Working animation never pretends to be verified learning progress
    learningVerifiedSignal: lastXpGain > 0 && !isWorking,
    numericLabel: `${clampedLevel}/${TOTAL_SKILL_DOTS}`,
    statusTextLabel: isLevel99
      ? 'MASTERED (99/99)'
      : (isStale ? `STALE (${clampedLevel}/99)` : `${maturityStatus} (${clampedLevel}/99)`),
    tickerText,
    dots,
  };
}

/**
 * Format the discreet XP ticker row, e.g.:
 *   "Formulär 18/99 · +24 XP"
 */
export function formatXpTicker({
  displayName = 'Formulär', // input vocabulary, never rendered
  level = 1,
  xpGain = 0,
  freshness = 'FRESH',
} = {}) {
  const lvl = Math.max(1, Math.min(TOTAL_SKILL_DOTS, Math.floor(Number(level) || 1)));
  const gain = Math.max(0, Math.floor(Number(xpGain) || 0));
  const staleSuffix = freshness === 'STALE' ? ' · STALE' : '';
  if (gain > 0) {
    return `${displayName} ${lvl}/${TOTAL_SKILL_DOTS} · +${gain} XP${staleSuffix}`;
  }
  return `${displayName} ${lvl}/${TOTAL_SKILL_DOTS}${staleSuffix}`;
}

/**
 * Attach a 2D Canvas 99-dot matrix around the Majin logo.
 */
export function createDotMatrixCanvas(canvas, { reducedMotion = false } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return {
      update() {},
      destroy() {},
      getState: () => computeDotMatrixState(),
    };
  }
  const ctx = canvas.getContext('2d');
  const raf = globalThis.requestAnimationFrame || ((fn) => {
    const timer = setTimeout(() => fn(Date.now()), 32);
    timer.unref?.(); // A headless canvas must not keep a Node test/host alive.
    return timer;
  });
  const caf = globalThis.cancelAnimationFrame || clearTimeout;
  let current = computeDotMatrixState();
  let rafId = null;
  let phase = 0;
  let lastFrame = 0;

  function draw() {
    if (!ctx) return;
    const w = canvas.width || 280;
    const h = canvas.height || 280;
    const cx = w / 2;
    const cy = h / 2;
    ctx.clearRect(0, 0, w, h);

    // Subtle dark aura behind Majin logo
    const bgGrad = ctx.createRadialGradient(cx, cy, 18, cx, cy, w * 0.46);
    if (current.cohesiveMastery99) {
      bgGrad.addColorStop(0, 'rgba(16, 185, 129, 0.28)');
      bgGrad.addColorStop(0.6, 'rgba(34, 197, 94, 0.10)');
      bgGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    } else if (current.activityState === 'working') {
      bgGrad.addColorStop(0, 'rgba(56, 189, 248, 0.18)');
      bgGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    } else {
      bgGrad.addColorStop(0, 'rgba(34, 197, 94, 0.12)');
      bgGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    }
    ctx.fillStyle = bgGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.46, 0, Math.PI * 2);
    ctx.fill();

    // A calm living emerald halo; working uses cyan/violet/amber without claiming earned XP.
    ctx.save();
    const pulse = reducedMotion ? 0.55 : (0.55 + 0.25 * Math.sin(phase * 1.4));
    ctx.strokeStyle = current.activityState === 'working' ? `rgba(82, 185, 255, ${pulse})` : `rgba(27, 233, 164, ${pulse})`;
    ctx.shadowColor = current.activityState === 'working' ? '#60bbff' : '#0de6a2';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.265, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Cohesive Level 99 emerald ring
    if (current.cohesiveMastery99) {
      ctx.save();
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.65)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, w * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Distinct outer activity ring when working (never lights green XP dots)
    if (current.activityState === 'working') {
      ctx.save();
      ctx.strokeStyle = reducedMotion ? 'rgba(56, 189, 248, 0.8)' : `hsla(${205 + Math.sin(phase * 0.5) * 57}, 90%, 68%, 0.83)`;
      ctx.lineWidth = 2;
      const startAngle = reducedMotion ? 0 : phase;
      ctx.beginPath();
      ctx.arc(cx, cy, w * 0.45, startAngle, startAngle + Math.PI * 0.85);
      ctx.stroke();
      ctx.restore();
    }

    // Draw the 99 dots in 3 concentric rings of 33 dots each
    const radii = [w * 0.29, w * 0.35, w * 0.41];
    for (const dot of current.dots) {
      const idxInRing = (dot.index - 1) % 33;
      // All green dots are earned, never simulated; only their positions move.
      const orbit = reducedMotion ? 0 : phase * (dot.ring % 2 === 0 ? 0.14 : -0.1);
      const angle = -Math.PI / 2 + (idxInRing / 33) * Math.PI * 2 + orbit;
      const r = radii[dot.ring];
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      ctx.beginPath();
      const dotRadius = dot.filled ? (current.cohesiveMastery99 ? 3.4 : 3.0) : 2.1;
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = dot.color;
      ctx.fill();

      if (dot.filled) {
        ctx.save();
        ctx.shadowColor = current.cohesiveMastery99 ? '#34d399' : '#22c55e';
        ctx.shadowBlur = current.cohesiveMastery99 ? 8 : 4;
        ctx.fillStyle = dot.color;
        ctx.fill();
        ctx.restore();
      }
    }
  }

  function tick(timestamp = 0) {
    if (lastFrame && timestamp && timestamp - lastFrame < 32) { rafId = raf(tick); return; }
    lastFrame = timestamp || 0;
    phase += current.activityState === 'working' ? 0.075 : 0.022;
    draw();
    rafId = reducedMotion ? null : raf(tick);
  }

  draw();
  if (ctx && !reducedMotion) rafId = raf(tick);

  return {
    update(nextSpec = {}) {
      current = computeDotMatrixState(nextSpec);
      canvas.setAttribute(
        'aria-label',
        `${current.displayName}: ${current.numericLabel} (${current.statusTextLabel})`,
      );
      draw();
      if (ctx && !reducedMotion && !rafId) {
        rafId = raf(tick);
      }
      return current;
    },
    getState() {
      return current;
    },
    destroy() {
      if (rafId) caf(rafId);
      rafId = null;
    },
  };
}
