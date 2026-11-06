/**
 * Core domain types for Studdy Buddy.
 *
 * Design rule that runs through the whole codebase: every piece of state that
 * describes the student is *evidence-backed*. Nothing here is allowed to be
 * "guessed" and later displayed as fact. Where a value may be unknown it is
 * explicitly nullable or carries a confidence.
 */

export type IsoDate = string;

// ---------------------------------------------------------------------------
// Curriculum
// ---------------------------------------------------------------------------

export type CurriculumNodeKind =
  | 'COURSE'
  | 'MODULE'
  | 'CHAPTER'
  | 'SECTION'
  | 'LESSON'
  | 'OBJECTIVE'
  | 'ACTIVITY'
  | 'LAB'
  | 'QUIZ';

export interface CurriculumNode {
  /** Stable id derived from URL/heading path; never random, so it survives restarts. */
  id: string;
  kind: CurriculumNodeKind;
  title: string;
  /** 1-based position within the parent, as reported by the platform. */
  order: number | null;
  url: string | null;
  parentId: string | null;
  /** Completion only when the platform itself reported it. */
  platformCompleted: boolean | null;
  /** True when the item exists but we cannot read its content/completion. */
  inaccessible: boolean;
}

export interface CurriculumGraph {
  courseId: string;
  courseName: string;
  /** Where the graph was discovered from (url of course root). */
  sourceUrl: string;
  discoveredAt: IsoDate;
  nodes: CurriculumNode[];
}

/** What the browser extension is currently looking at (any site). */
export type { SourcePage, SourceKind } from './source.js';

export type AssessmentMode =
  | 'SELF_STUDY'
  | 'PRACTICE'
  | 'GRADED_QUIZ'
  | 'FORMAL_EXAM'
  | 'UNKNOWN';

export interface QuizOption {
  label: string;
  text: string;
}

/** A question as observed on the page. Observation only - not an answer key. */
export interface ObservedQuestion {
  id: string;
  questionText: string;
  options: QuizOption[];
  questionType: 'MULTIPLE_CHOICE' | 'MULTIPLE_ANSWER' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'MATCHING' | 'UNKNOWN';
  /** Only set when the platform visibly says so. */
  officialCorrectness: boolean | null;
  /** Answer chosen by the student when we can see it. */
  selected: string[];
  feedbackVisible: boolean;
  mode: AssessmentMode;
  conceptId: string | null;
}

export interface SelectionContext {
  text: string;
  url: string;
  /** Bounding rect in CSS pixels relative to the viewport. */
  rect: { x: number; y: number; width: number; height: number } | null;
}

// ---------------------------------------------------------------------------
// Desktop observation
// ---------------------------------------------------------------------------

export type SupportedAppKind = 'NETACAD' | 'PACKET_TRACER' | 'OTHER';

export interface WindowInfo {
  id: string;
  title: string;
  processName: string;
  appKind: SupportedAppKind;
  bounds: { x: number; y: number; width: number; height: number };
  /** Display the window lives on, for DPI-aware coordinate mapping. */
  displayId: string | null;
  minimized: boolean;
  /** Windows foreground state from agent-desktop; optional for older fixtures. */
  focused?: boolean;
}

export interface UiElementInfo {
  /** Opaque reference produced by the accessibility adapter; may go stale. */
  ref: string;
  role: string;
  name: string;
  value: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  enabled: boolean;
  /** True when a fresh snapshot must be taken before acting on it. */
  stale: boolean;
}

export interface UiSnapshot {
  windowId: string;
  takenAt: IsoDate;
  elements: UiElementInfo[];
  /** Honest marker: the adapter could not read the accessibility tree. */
  accessible: boolean;
  note: string | null;
}

export interface DisplayInfo {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  isPrimary: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Packet Tracer observation
// ---------------------------------------------------------------------------

export type DeviceKind = 'PC' | 'SWITCH' | 'ROUTER' | 'SERVER' | 'ACCESS_POINT' | 'UNKNOWN';

export interface ObservedDevice {
  id: string;
  label: string;
  kind: DeviceKind;
  /** Only when we can actually see/read it. */
  interfaces: ObservedInterface[];
  /** Where the information came from - never fabricated. */
  evidence: 'ACCESSIBILITY' | 'CLI_TEXT' | 'VISION' | 'STUDENT_REPORT';
  bounds: Rect | null;
}

export interface ObservedInterface {
  name: string;
  ipAddress: string | null;
  subnetMask: string | null;
  status: 'up' | 'down' | 'admin-down' | 'unknown';
  vlan: number | null;
}

export interface ShowCommandOutput {
  command: string;
  deviceLabel: string | null;
  raw: string;
}

export interface TopologyObservation {
  capturedAt: IsoDate;
  devices: ObservedDevice[];
  /** Free-form findings extracted from visible CLI output. */
  cliOutputs: ShowCommandOutput[];
  /** Honest limit report; the UI must be able to say "I could not see X". */
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Learning model
// ---------------------------------------------------------------------------

export type ConceptState =
  | 'NOT_SEEN'
  | 'EXPOSED'
  | 'PRACTICING'
  | 'DEVELOPING'
  | 'DEMONSTRATED'
  | 'MASTERED'
  | 'REVIEW_DUE';

export interface MasteryEstimate {
  conceptId: string;
  /** P(L) from Bayesian Knowledge Tracing, 0..1. */
  probability: number;
  state: ConceptState;
  evidenceCount: number;
  /** Number of independent (unhinted) correct answers. */
  independentCorrect: number;
  lastEvidenceAt: IsoDate | null;
  reviewDueAt: IsoDate | null;
  /** Shrinks when evidence is thin; the UI shows this rather than a fake percent. */
  confidence: number;
}

export type EvidenceKind =
  | 'QUIZ_CORRECT'
  | 'QUIZ_INCORRECT'
  | 'HINTED_CORRECT'
  | 'EXPLAINED_BACK'
  | 'PRACTICAL_SUCCESS'
  | 'READING_EXPOSURE';

export interface LearningEvidenceInput {
  conceptId: string;
  kind: EvidenceKind;
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** Hints consumed before the answer; reduces credit for independent mastery. */
  hintsUsed: number;
  source: 'NETACAD' | 'QUIZ_ENGINE' | 'PACKET_TRACER' | 'CHAT';
  detail?: string;
}

export interface ConceptDependency {
  conceptId: string;
  prerequisiteId: string;
}

// ---------------------------------------------------------------------------
// Explanation contract
// ---------------------------------------------------------------------------

export type ResponseMode = 'QUICK' | 'NORMAL' | 'TEACH' | 'DEEP' | 'STEP_BY_STEP' | 'DEBUG';

/**
 * Internal structured representation. The renderer chooses which fields to
 * display based on mode; the model fills this, it never speaks raw prose.
 */
export interface StructuredResponse {
  directAnswer: string;
  simpleExplanation?: string;
  example?: string;
  nextAction?: string;
  deeperExplanation?: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warn';
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'buddy' | 'system';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  text: string;
  /** Structured payload when Buddy produced an explanation. */
  structured: StructuredResponse | null;
  mode: ResponseMode;
  createdAt: IsoDate;
  /** True while streaming. */
  pending?: boolean;
  error?: string | null;
  /** Suggested quick replies / action chips. */
  chips?: string[];
}

export interface StudySession {
  id: string;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
  courseId: string | null;
  lastNodeId: string | null;
  lastNodeTitle: string | null;
  topicSummary: string | null;
}

// ---------------------------------------------------------------------------
// Provider / AI
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  visionModelId: string | null;
  fallbackModelId: string | null;
  reasoning: 'off' | 'auto' | 'deep';
  maxTokensPerRequest: number;
  dailyCostLimitUsd: number;
  /** USD per 1M input/output tokens; only used for local budgeting. */
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  /** Never persisted in plaintext; the store keeps only a keychain reference. */
  hasApiKey: boolean;
}

export interface ModelCapabilities {
  text: boolean;
  streaming: boolean;
  vision: boolean;
  json: boolean;
  tools: boolean;
  /** Context window if the endpoint reported it, else null. */
  contextTokens: number | null;
  testedAt: IsoDate | null;
}

export interface ProviderUsage {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}
