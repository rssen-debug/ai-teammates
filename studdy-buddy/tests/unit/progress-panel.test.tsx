// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ProgressPanel } from '@studdy/chat-ui';
import { computeReadiness, type ReadinessConcept } from '@studdy/learning-engine';
import type { CurriculumGraph } from '@studdy/shared';

/**
 * The progress panel is the only place a student sees a single number about
 * themselves, so these tests render the real component into jsdom and check what
 * is actually on screen — not what the props say.
 */

const GRAPH: CurriculumGraph = {
  courseId: 'course:itn',
  courseName: 'CCNA ITN',
  sourceUrl: 'https://www.netacad.com/course',
  discoveredAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    { id: 'c', kind: 'COURSE', title: 'CCNA ITN', order: 1, url: null, parentId: null, platformCompleted: null, inaccessible: false },
    { id: 'm1', kind: 'MODULE', title: 'Modul 1', order: 1, url: null, parentId: 'c', platformCompleted: true, inaccessible: false },
    { id: 'm2', kind: 'MODULE', title: 'Modul 2', order: 2, url: null, parentId: 'c', platformCompleted: null, inaccessible: false },
    { id: 'm3', kind: 'MODULE', title: 'Modul 3', order: 3, url: null, parentId: 'c', platformCompleted: false, inaccessible: false },
  ],
};

function concept(over: Partial<ReadinessConcept> & { conceptId: string }): ReadinessConcept {
  return { label: over.conceptId, probability: 0, state: 'NOT_SEEN', confidence: 0, independentCorrect: 0, reviewDueAt: null, overdue: false, ...over };
}

function render(element: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('progress panel', () => {
  it('shows a 0-100 score next to its derivation when it can be measured', () => {
    const readiness = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', label: 'ARP', state: 'DEMONSTRATED', probability: 0.8, confidence: 0.7, independentCorrect: 3 }),
        concept({ conceptId: 'subnetting', label: 'Subnetting', state: 'PRACTICING', probability: 0.3, confidence: 0.3, independentCorrect: 1 }),
      ],
      graph: GRAPH,
    });
    const { container, unmount } = render(
      <ProgressPanel
        readiness={readiness}
        course={{ name: 'CCNA ITN', moduleCount: 3 }}
        currentPosition={['Modul 1', '1.2 Vad är ett nätverk']}
        platform={{ completed: 1, total: 3 }}
        onClose={() => undefined}
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toContain(String(readiness.score));
    expect(text).toContain('/100');
    // Every part is shown with its weight, so the number is auditable on screen.
    expect(text).toContain('Täckning');
    expect(text).toContain('Kunskap');
    expect(text).toContain('Retention');
    expect(text).toContain('vikt 40');
    expect(text).toContain('vikt 20');
    expect(container.querySelectorAll('[role="meter"]')).toHaveLength(3);
    unmount();
  });

  it('shows a dash, not zero, when nothing can be measured', () => {
    const readiness = computeReadiness({ concepts: [concept({ conceptId: 'arp' })], graph: GRAPH });
    const { container, unmount } = render(
      <ProgressPanel readiness={readiness} course={null} currentPosition={null} platform={null} onClose={() => undefined} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Ingen beredskap kan mätas');
    expect(text).toContain('–');
    // No zero is presented as if it were a measurement.
    expect(text).not.toContain('/100');
    unmount();
  });

  it('always renders the limitations, so the number cannot appear unqualified', () => {
    const readiness = computeReadiness({
      concepts: [concept({ conceptId: 'arp', label: 'ARP', state: 'PRACTICING', probability: 0.6, confidence: 0.2, independentCorrect: 1 })],
      graph: GRAPH,
    });
    const { container, unmount } = render(
      <ProgressPanel readiness={readiness} course={null} currentPosition={null} platform={null} onClose={() => undefined} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Vad siffran inte säger');
    for (const limitation of readiness.limitations) expect(text).toContain(limitation);
    unmount();
  });

  it('separates platform completion from knowledge in the copy', () => {
    const readiness = computeReadiness({
      concepts: [concept({ conceptId: 'arp', state: 'EXPOSED', probability: 0.2, confidence: 0.1 })],
      graph: GRAPH,
    });
    const { container, unmount } = render(
      <ProgressPanel
        readiness={readiness}
        course={{ name: 'CCNA ITN', moduleCount: 3 }}
        currentPosition={null}
        platform={{ completed: 1, total: 3 }}
        onClose={() => undefined}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Plattformen rapporterar 1 av 3 klara');
    expect(text).toContain('räknas aldrig som kunskap');
    unmount();
  });

  it('shows next steps and the weakest concepts', () => {
    const readiness = computeReadiness({
      concepts: [
        concept({ conceptId: 'arp', label: 'ARP', state: 'MASTERED', probability: 0.9, confidence: 0.8, independentCorrect: 4 }),
        concept({ conceptId: 'subnetting', label: 'Subnetting', state: 'PRACTICING', probability: 0.25, confidence: 0.3, independentCorrect: 1 }),
      ],
      graph: GRAPH,
    });
    const { container, unmount } = render(
      <ProgressPanel readiness={readiness} course={null} currentPosition={null} platform={null} onClose={() => undefined} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Nästa steg');
    expect(text).toContain('Subnetting');
    expect(text).toContain('Svagast just nu');
    unmount();
  });
});
