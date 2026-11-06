import type { RawPageSnapshot } from '@studdy/curriculum';

/**
 * Synthetic but structurally faithful NetAcad page snapshots.
 *
 * These are NOT recordings of the live product (we do not have access to it in
 * this environment - see BUILD_STATUS.md). They encode the shapes the
 * extension is written to read: a sidebar TOC with numeric section paths, a
 * course heading, and an optional iframe body.
 */

export function makeSnapshot(options: {
  moduleCount: number;
  sectionsPerModule?: number;
  courseName?: string;
  iframe?: boolean;
}): RawPageSnapshot {
  const sectionsPerModule = options.sectionsPerModule ?? 3;
  const navLinks: RawPageSnapshot['navLinks'] = [];
  for (let m = 1; m <= options.moduleCount; m += 1) {
    navLinks.push({ text: `Module ${m}: Topic ${m}`, href: `/course/module-${m}`, depth: 1, completed: m < 3 ? true : null });
    for (let s = 1; s <= sectionsPerModule; s += 1) {
      navLinks.push({ text: `${m}.${s} Section ${m}.${s}`, href: `/course/module-${m}/section-${m}-${s}`, depth: 2, completed: null });
      navLinks.push({ text: `${m}.${s}.1 Lesson ${m}.${s}.1`, href: `/course/module-${m}/section-${m}-${s}-1`, depth: 3, completed: null });
    }
    navLinks.push({ text: `Lab ${m}: Configure devices`, href: `/course/module-${m}/lab`, depth: 2, completed: null });
    navLinks.push({ text: `Module ${m} Quiz`, href: `/course/module-${m}/quiz`, depth: 2, completed: null });
  }

  return {
    url: 'https://www.netacad.com/courses/networking/ccna-itn',
    title: `${options.courseName ?? 'CCNA: Introduction to Networks'} | NetAcad`,
    courseName: options.courseName ?? 'CCNA: Introduction to Networks',
    headings: [
      { level: 1, text: options.courseName ?? 'CCNA: Introduction to Networks' },
      { level: 2, text: 'Module 3: Protocols and Models' },
      { level: 3, text: '3.2 Network Protocols' },
      { level: 4, text: '3.2.1 The TCP/IP Protocol Suite' },
    ],
    navLinks,
    contentInIframe: options.iframe ?? false,
    capturedAt: '2026-02-01T09:00:00.000Z',
  };
}
