/**
 * Source-agnostic page model.
 *
 * The product requirement is that Studdy Buddy works for *whatever* the student
 * studies: Canvas, NetAcad, Moodle, Itslearning, a PDF reader in the browser, a
 * university portal, or a course someone wrote themselves. Nothing below may
 * assume "NetAcad".
 *
 * So the extension does not report "a NetAcad page". It reports a *SourcePage*:
 * a URL, a site guess, the heading trail, the navigation tree the site itself
 * rendered, and an honest statement about what could not be read. The desktop
 * app then derives whatever hierarchy that snapshot supports
 * (`@studdy/curriculum`), and the generic concept extractor
 * (`@studdy/learning-engine`) turns it into topics.
 *
 * `NetAcadPageContext` is kept as a deprecated alias so older code keeps
 * compiling; new code uses `SourcePage`.
 */

import type { IsoDate } from './types.js';

export type SourceKind =
  /** Learning management system: Canvas, Moodle, Blackboard, Itslearning, ... */
  | 'LMS'
  /** Vendor academy portal: NetAcad, SkillsForAll, Coursera, ... */
  | 'ACADEMY'
  /** Documentation / reference site. */
  | 'DOCS'
  /** Anything else the student pointed us at. */
  | 'WEB'
  /** Local desktop application (Packet Tracer, an IDE, a PDF reader). */
  | 'DESKTOP_APP';

export interface SourcePage {
  url: string;
  /** Page title as rendered, no invention. */
  title?: string;
  /** Site/course name as shown by the page, if it shows one. */
  courseName: string | null;
  /**
   * Best-effort site label derived from the hostname and page hints, e.g.
   * "Canvas", "NetAcad", "Moodle". Used for display only; never for logic.
   */
  siteName?: string | null;
  siteKind?: SourceKind;
  /** Heading trail, outermost first, exactly as rendered. */
  headingPath: string[];
  /** Best-effort id of the deepest known CurriculumNode. */
  currentNodeId: string | null;
  platformCompletedVisible: boolean | null;
  detectedAt: IsoDate;
}

/** @deprecated Use `SourcePage`. Kept so existing imports keep working. */
export type NetAcadPageContext = SourcePage;
