// Shared data model. Everything in src/core is pure (no Obsidian import) so it can be unit-tested.

export type FileKind = "markdown" | "pdf" | "image" | "canvas" | "office" | "other";

/** A file as seen by the scanner: vault-relative path, size in bytes, mtime in ms. */
export interface VaultFile {
  path: string;
  size: number;
  mtime: number;
}

export const DOC_TYPES = [
  "cours", // slides, polycopié
  "exercices", // TD, TP, problem sets
  "corrige", // solutions
  "notes", // own notes, typed
  "tableau", // photo of the board
  "cahier", // photo/scan of handwritten notebook
  "annale", // past exams
  "syllabus", // course outline, planning, grading rules
  "formulaire", // cheat sheet
  "lecture", // papers, book chapters
  "dashboard", // MOC, index, skill tree, canvas
  "autre",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** What Claude learnt about one file. Cached by fingerprint so a file is only read once. */
export interface FileDigest {
  docType: DocType;
  title: string;
  summary: string;
  topics: string[];
  /** "Séance 3", "Chapitre 2", a date... anything that orders the document in the course. */
  sequence: string | null;
  /** Markdown transcription of a photo of the board or notebook (only when transcription is on). */
  transcript: string | null;
}

export interface Resource {
  /** Vault-relative path of the file, after the plan is applied. */
  path: string;
  role: DocType;
  label: string;
}

export type ModuleStatus = "todo" | "doing" | "done";

export interface ModuleNode {
  /** Stable slug, e.g. "m02-pricing-options". Canvas node ids derive from it. */
  id: string;
  title: string;
  summary: string;
  concepts: string[];
  /** Ids of modules that should be mastered first (skill-tree edges). */
  prerequisites: string[];
  /** Vault-relative folder of the module, or null when it has none. */
  folder: string | null;
  resources: Resource[];
  children: ModuleNode[];
  /** Read back from the canvas node colour, so the user tracks progress in the canvas itself. */
  status?: ModuleStatus;
}

/** The persisted structure of a course (<course>/_curator.json). */
export interface CourseMap {
  version: 1;
  course: string;
  folder: string;
  summary: string;
  modules: ModuleNode[];
  /** Course-wide resources: syllabus, past exams, cheat sheets... */
  transverse: Resource[];
  /** Existing dashboards kept next to the generated one. */
  keptDashboards: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Plans

export type OpKind = "mkdir" | "move" | "archive" | "create_note" | "append_note" | "transcribe";

/**
 * One reviewable step. Paths are vault-relative. Ops run in order and each path refers to the
 * vault state after the previous ops (a file moved by op 3 is addressed by its new path in op 7).
 */
export interface PlanOp {
  kind: OpKind;
  /** move/archive: what is moved. transcribe: the image. append_note/create_note: unused. */
  source: string | null;
  /** mkdir/create_note/append_note/move/transcribe: the resulting path. archive: computed. */
  target: string | null;
  /** create_note/append_note: markdown body. transcribe: filled from the digest. */
  content: string | null;
  reason: string;
}

export interface DashboardDecision {
  path: string;
  decision: "keep" | "merge" | "archive";
  rationale: string;
}

export interface Plan {
  course: string;
  folder: string;
  summary: string;
  ops: PlanOp[];
  dashboards: DashboardDecision[];
  /** Full course map (onboarding) — resources use final paths. */
  courseMap: CourseMap;
  /** Points Claude could not settle and wants the user to look at. */
  questions: string[];
}

/** Result of validating a plan against a simulated vault. */
export interface CheckedOp extends PlanOp {
  index: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Journal (undo)

export type JournalStep =
  | { type: "mkdir"; path: string }
  | { type: "rmdir"; path: string }
  | { type: "move"; from: string; to: string }
  | { type: "create"; path: string; content: string }
  | { type: "modify"; path: string; before: string; after: string };

export interface JournalEntry {
  id: string;
  date: string;
  label: string;
  steps: JournalStep[];
  /** Course maps as they were before the operation, keyed by course folder (null = no map). */
  mapsBefore: Record<string, CourseMap | null>;
}
