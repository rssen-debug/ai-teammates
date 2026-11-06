import type { ReadinessScore } from '@studdy/learning-engine';
import { darkTheme, themeToCssVars, type Theme } from './theme.js';

/**
 * Progress panel.
 *
 * One number, on a 0-100 scale, because that is what the student asked for — and
 * next to it, everything that number is made of. The rule this component enforces:
 * **a percentage may never be shown without its derivation, its evidence strength
 * and its limitations.** If the scale cannot be computed, it says so instead of
 * showing 0.
 *
 * Not a dashboard: it lives inside the same bubble as the chat and is opened on
 * demand.
 */

export interface ProgressPanelProps {
  readiness: ReadinessScore;
  course: { name: string; moduleCount: number } | null;
  currentPosition: string[] | null;
  /** Which course parts the platform itself reports as done, never merged with mastery. */
  platform: { completed: number; total: number } | null;
  onClose: () => void;
  theme?: Theme;
}

export function ProgressPanel(props: ProgressPanelProps) {
  const theme = props.theme ?? darkTheme;
  const { readiness } = props;

  return (
    <div style={themeToCssVars(theme) as React.CSSProperties} className="buddy-progress" role="dialog" aria-label="Framsteg och tentaberedskap">
      <style>{progressCss}</style>
      <header>
        <h2>Framsteg</h2>
        <button type="button" className="buddy-p-btn" onClick={props.onClose} aria-label="Stäng framsteg">
          ✕
        </button>
      </header>

      <section className="buddy-p-score" aria-live="polite">
        {readiness.score === null ? (
          <>
            <div className="buddy-p-number is-unknown">–</div>
            <p className="buddy-p-headline">{readiness.headline}</p>
          </>
        ) : (
          <>
            <div className="buddy-p-number">
              {readiness.score}
              <span>/100</span>
            </div>
            <p className="buddy-p-headline">{readiness.headline}</p>
            <p className="buddy-p-confidence">
              Underlag: <strong>{readiness.confidence}</strong>
            </p>
          </>
        )}
      </section>

      {readiness.score !== null && (
        <section className="buddy-p-parts">
          <Part label="Täckning" {...readiness.parts.coverage} />
          <Part label="Kunskap" {...readiness.parts.mastery} />
          <Part label="Retention" {...readiness.parts.retention} />
        </section>
      )}

      {readiness.limitations.length > 0 && (
        <section className="buddy-p-limits">
          <h3>Vad siffran inte säger</h3>
          <ul>
            {readiness.limitations.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {props.course && (
        <section className="buddy-p-course">
          <h3>Kurs</h3>
          <p>
            {props.course.name} · {props.course.moduleCount} moduler hittade på sidan
          </p>
          {props.currentPosition && props.currentPosition.length > 0 && (
            <p className="buddy-p-muted">Du är i: {props.currentPosition.join(' › ')}</p>
          )}
          {props.platform && (
            <p className="buddy-p-muted">
              Plattformen rapporterar {props.platform.completed} av {props.platform.total} klara. Det är kursens egen
              markering och räknas aldrig som kunskap här.
            </p>
          )}
        </section>
      )}

      {readiness.nextSteps.length > 0 && (
        <section className="buddy-p-next">
          <h3>Nästa steg</h3>
          <ul>
            {readiness.nextSteps.map((step) => (
              <li key={step.conceptId}>
                <strong>{step.label}</strong> — {step.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      {readiness.weak.length > 0 && (
        <section className="buddy-p-concepts">
          <h3>Svagast just nu</h3>
          <ul>
            {readiness.weak.map((c) => (
              <li key={c.conceptId}>
                <span>{c.label}</span>
                <Meter value={c.probability} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Part(props: { label: string; value: number; weight: number; detail: string }) {
  return (
    <div className="buddy-p-part">
      <div className="buddy-p-part-head">
        <span>{props.label}</span>
        <span className="buddy-p-muted">
          {props.value}/100 · vikt {props.weight}
        </span>
      </div>
      <div className="buddy-p-bar" role="meter" aria-valuenow={props.value} aria-valuemin={0} aria-valuemax={100} aria-label={props.label}>
        <span style={{ width: `${Math.max(0, Math.min(100, props.value))}%` }} />
      </div>
      <p className="buddy-p-muted">{props.detail}</p>
    </div>
  );
}

function Meter({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="buddy-p-meter" title={`${pct} %`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

const progressCss = `
  .buddy-progress {
    display: flex; flex-direction: column; gap: 14px;
    padding: 16px; border-radius: 18px;
    max-height: 60vh; overflow-y: auto;
    font-size: 13px; line-height: 1.5;
  }
  .buddy-progress header { display: flex; align-items: center; justify-content: space-between; }
  .buddy-progress h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .buddy-progress h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .6; font-weight: 600; }
  .buddy-progress p { margin: 0; }
  .buddy-p-score { text-align: center; padding: 6px 0 2px; }
  .buddy-p-number { font-size: 44px; font-weight: 650; letter-spacing: -0.02em; line-height: 1; }
  .buddy-p-number span { font-size: 15px; opacity: .45; font-weight: 500; margin-left: 2px; }
  .buddy-p-number.is-unknown { opacity: .35; }
  .buddy-p-headline { margin-top: 8px; font-size: 12.5px; opacity: .8; }
  .buddy-p-confidence { margin-top: 4px; font-size: 11px; opacity: .55; }
  .buddy-p-parts { display: flex; flex-direction: column; gap: 10px; }
  .buddy-p-part-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
  .buddy-p-bar, .buddy-p-meter {
    display: block; height: 6px; border-radius: 999px; overflow: hidden;
    background: rgba(255,255,255,.10);
  }
  .buddy-p-bar span, .buddy-p-meter span { display: block; height: 100%; border-radius: 999px; background: currentColor; opacity: .75; }
  .buddy-p-muted { font-size: 11px; opacity: .55; margin-top: 4px; }
  .buddy-p-limits ul, .buddy-p-next ul, .buddy-p-concepts ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .buddy-p-limits li { font-size: 11.5px; opacity: .7; padding-left: 12px; position: relative; }
  .buddy-p-limits li::before { content: '·'; position: absolute; left: 0; }
  .buddy-p-concepts li { display: flex; align-items: center; gap: 8px; justify-content: space-between; font-size: 12px; }
  .buddy-p-meter { width: 80px; flex: none; }
  .buddy-p-next li { font-size: 12px; }
  .buddy-p-btn { background: none; border: none; color: inherit; cursor: pointer; font-size: 13px; opacity: .6; }
`;
