import { useEffect, useState } from 'react';
import type { Rect } from '@studdy/shared';
import type { Annotation, AnnotationPlan } from './geometry.js';

/**
 * The transparent annotation layer.
 *
 * Rendered in a separate always-on-top, click-through Electron window. The
 * component is deliberately dumb: the main process computes the plan (with all
 * the DPI/staleness handling in geometry.ts) and pushes it here. That keeps the
 * risky coordinate maths testable in Node instead of living in the renderer.
 */

export interface OverlayProps {
  plan: AnnotationPlan | null;
  /** Offset of the overlay window in virtual-desktop coordinates. */
  origin?: Rect;
  reducedMotion?: boolean;
  onDismiss?: () => void;
}

export function Overlay({ plan, origin, reducedMotion = false, onDismiss }: OverlayProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!plan) {
      setVisible(false);
      return;
    }
    // Small delay so the paint does not flicker in during a window move.
    const t = setTimeout(() => setVisible(true), reducedMotion ? 0 : 60);
    return () => clearTimeout(t);
  }, [plan, reducedMotion]);

  useEffect(() => {
    if (!plan) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [plan, onDismiss]);

  if (!plan || plan.annotations.length === 0) return null;

  const dx = origin?.x ?? 0;
  const dy = origin?.y ?? 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: reducedMotion ? 'none' : 'opacity 160ms ease-out',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      <style>{overlayCss}</style>
      {plan.annotations.map((annotation) => (
        <AnnotationView key={annotation.id} annotation={annotation} dx={dx} dy={dy} reducedMotion={reducedMotion} />
      ))}
      {plan.warnings.length > 0 && (
        <div className="buddy-overlay-warning" style={{ top: 16 + dy, left: 16 + dx }}>
          {plan.warnings.join(' ')}
        </div>
      )}
    </div>
  );
}

function AnnotationView({ annotation, dx, dy, reducedMotion }: { annotation: Annotation; dx: number; dy: number; reducedMotion: boolean }) {
  const { rect, kind, label, step } = annotation;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: rect.x - dx,
    top: rect.y - dy,
    width: rect.width,
    height: rect.height,
  };

  switch (kind) {
    case 'ring':
      return (
        <div style={style} className="buddy-overlay-ring">
          <div className="buddy-overlay-ring-inner" style={{ animation: reducedMotion ? 'none' : 'buddy-ring-pulse 1.8s ease-out infinite' }} />
          {label && (
            <div className="buddy-overlay-label" style={{ top: rect.height + 10 }}>
              {step ? <span className="buddy-overlay-step">{step}</span> : null}
              {label}
            </div>
          )}
        </div>
      );
    case 'box':
      return <div style={style} className="buddy-overlay-box" aria-label={label} />;
    case 'arrow':
      return (
        <div style={style} className="buddy-overlay-arrow">
          <svg width={rect.width} height={rect.height} viewBox={`0 0 ${rect.width} ${rect.height}`} preserveAspectRatio="none">
            <defs>
              <marker id="buddy-arrowhead" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L7,3 z" fill="#7CC4A0" />
              </marker>
            </defs>
            <line x1="0" y1={rect.height} x2={rect.width} y2="0" stroke="#7CC4A0" strokeWidth="3" markerEnd="url(#buddy-arrowhead)" strokeLinecap="round" />
          </svg>
        </div>
      );
    case 'spotlight':
      return <div style={style} className="buddy-overlay-spotlight" />;
    case 'step':
      return (
        <div style={style} className="buddy-overlay-step-badge">
          {step}
        </div>
      );
    case 'tooltip':
    default:
      return (
        <div style={{ ...style, height: 'auto' }} className="buddy-overlay-tooltip">
          {label}
        </div>
      );
  }
}

const overlayCss = `
.buddy-overlay-ring {
  border-radius: 10px;
  box-shadow: 0 0 0 2px rgba(124,196,160,0.95), 0 0 24px rgba(124,196,160,0.35);
  background: rgba(124,196,160,0.08);
}
.buddy-overlay-ring-inner { position:absolute; inset:-6px; border-radius:14px; border:2px solid rgba(124,196,160,0.55); }
.buddy-overlay-box { border-radius:8px; box-shadow: 0 0 0 2px rgba(124,196,160,0.9); background: rgba(124,196,160,0.10); }
.buddy-overlay-spotlight { border-radius:12px; box-shadow: 0 0 0 9999px rgba(8,10,14,0.45); }
.buddy-overlay-label {
  position:absolute; left:0; max-width: 320px; padding: 8px 12px; border-radius: 10px;
  background: rgba(20,24,30,0.94); color: #F1F5F9; font-size: 13px; line-height: 1.35;
  box-shadow: 0 8px 24px rgba(0,0,0,0.28); white-space: normal; display:flex; gap:8px; align-items:flex-start;
}
.buddy-overlay-step {
  flex: 0 0 auto; width:18px; height:18px; border-radius:50%; background:#7CC4A0; color:#0B1116;
  font-size:11px; font-weight:700; display:inline-flex; align-items:center; justify-content:center;
}
.buddy-overlay-tooltip {
  padding: 8px 12px; border-radius: 10px; background: rgba(20,24,30,0.94); color:#F1F5F9;
  font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,0.28);
}
.buddy-overlay-step-badge {
  position:absolute; width:24px; height:24px; border-radius:50%; background:#7CC4A0; color:#0B1116;
  display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px;
}
.buddy-overlay-warning {
  position:absolute; max-width: 360px; padding: 6px 10px; border-radius: 8px;
  background: rgba(120,72,20,0.92); color:#FFF7ED; font-size:12px;
}
@keyframes buddy-ring-pulse {
  0% { transform: scale(1); opacity: 0.9; }
  70% { transform: scale(1.06); opacity: 0; }
  100% { transform: scale(1.06); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
`;

export { type Annotation, type AnnotationPlan };
