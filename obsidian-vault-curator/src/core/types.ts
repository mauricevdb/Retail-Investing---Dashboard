// Shared data model. Everything in src/core is pure (no Obsidian import) so it can be unit-tested.

export type FileKind = "markdown" | "pdf" | "image" | "canvas" | "office" | "data" | "code" | "other";

/** A file as seen by the scanner: vault-relative path, size in bytes, mtime in ms. */
export interface VaultFile {
  path: string;
  size: number;
  mtime: number;
}

/** What a document is, whatever the folder it lives in. */
export const DOC_TYPES = [
  "cours", // course material: slides, handouts
  "exercices", // exercises, problem sets, past exams
  "corrige", // solutions
  "notes", // typed notes, meeting notes, drafts
  "manuscrit", // handwritten notes, photos of a board or notebook, scans of paper notes
  "photo", // any other picture
  "lecture", // articles, papers, books, chapters
  "reference", // documentation, manuals, cheat sheets, guides
  "rapport", // reports, deliverables, memos, theses
  "presentation", // decks made to be presented
  "donnees", // datasets, spreadsheets, exports
  "code", // scripts, notebooks
  "admin", // contracts, invoices, forms, official documents, receipts
  "correspondance", // emails, letters, messages
  "planning", // syllabus, roadmap, schedule, to-do, timeline
  "journal", // daily notes, logs, diaries
  "modele", // templates
  "dashboard", // index, MOC, map of content, canvas
  "autre",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** What Claude learnt about one file. Cached by fingerprint so a file is only read once. */
export interface FileDigest {
  docType: DocType;
  title: string;
  summary: string;
  topics: string[];
  /** Anything that orders the document: "Séance 3", "Chapitre 2", "Phase 1", a date… */
  sequence: string | null;
  /** Markdown transcription of handwritten material (only when transcription is on). */
  transcript: string | null;
}

export interface Resource {
  /** Vault-relative path of the file, after the plan is applied. */
  path: string;
  role: DocType;
  label: string;
}

export type SectionStatus = "todo" | "doing" | "done";

export interface SectionNode {
  /** Stable slug, e.g. "s02-pricing-options". Canvas node ids derive from it. */
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  /** Ids of sections that come first (prerequisite, earlier phase…): the dashboard arrows. */
  dependsOn: string[];
  /** Vault-relative folder of the section, or null when it has none. */
  folder: string | null;
  resources: Resource[];
  children: SectionNode[];
  /** Read back from the canvas node colour, so the user tracks progress in the canvas itself. */
  status?: SectionStatus;
}

/** What the arrows of the dashboard mean. */
export type LinkKind = "prerequisite" | "sequence" | "none";

/** The persisted structure of a managed folder (<folder>/_curator.json). */
export interface SpaceMap {
  version: 2;
  name: string;
  folder: string;
  /** Free text chosen by Claude: "cours", "projet", "recherche", "administratif"… */
  kind: string;
  summary: string;
  /** What the folder is for. */
  purpose: string;
  /** How the user uses it and what makes that use efficient. */
  usage: string;
  /** Agreed organisation rules, applied to every future document. */
  conventions: string;
  /** What the user said they want, distilled from their feedback. */
  preferences: string[];
  /** Title of the dashboard: "Skill tree", "Feuille de route", "Carte thématique"… */
  dashboardTitle: string;
  linkKind: LinkKind;
  sections: SectionNode[];
  /** Folder-wide resources (syllabus, contacts, templates…). */
  transverse: Resource[];
  /** Existing dashboards kept next to the generated one. */
  keptDashboards: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Plans

export type OpKind = "mkdir" | "move" | "archive" | "create_note" | "append_note" | "transcribe" | "integrate";

/**
 * One reviewable step. Paths are vault-relative. Ops run in order and each path refers to the
 * vault state after the previous ops (a file moved by op 3 is addressed by its new path in op 7).
 */
export interface PlanOp {
  kind: OpKind;
  /** move/archive: what is moved. transcribe: the image. Unused otherwise. */
  source: string | null;
  /** integrate: the handwritten documents (or old transcription notes) whose content goes into the target note. */
  sources?: string[] | null;
  /** mkdir/create_note/append_note/move/transcribe/integrate: the resulting path. archive: computed. */
  target: string | null;
  /** create_note/append_note: markdown body. transcribe: filled from the digest. integrate: the whole note after merging, prepared by the plugin. */
  content: string | null;
  reason: string;
}

export interface DashboardDecision {
  path: string;
  decision: "keep" | "merge" | "archive";
  rationale: string;
}

/** Claude's reading of the folder, shown first so the user can correct it. */
export interface Understanding {
  kind: string;
  purpose: string;
  usage: string;
  /** The organising principle behind the plan, and why. */
  principle: string;
}

export interface Plan {
  space: string;
  folder: string;
  summary: string;
  understanding: Understanding;
  ops: PlanOp[];
  dashboards: DashboardDecision[];
  /** Full map (initial plan) — resources use final paths. */
  map: SpaceMap;
  /** Points Claude could not settle and wants the user to answer. */
  questions: string[];
  /** What changed since the previous version of the plan (revisions only). */
  changes: string[];
}

/** Result of validating a plan against a simulated vault. */
export interface CheckedOp extends PlanOp {
  index: number;
  error: string | null;
  /** Something the user should look at before applying (the op starts unticked). */
  warning?: string | null;
  /** integrate: the note as it is today (null when the note is created). */
  before?: string | null;
}

/** What the user says about a plan before validating it. */
export interface Feedback {
  answers: { question: string; answer: string }[];
  /** Comments on specific ops (by index in the plan). */
  opComments: { index: number; comment: string }[];
  /** Ops the user unticked. */
  refused: number[];
  /** Destinations the user edited by hand. */
  edited: { index: number; target: string }[];
  general: string;
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
  /** Maps as they were before the operation, keyed by folder (null = no map). */
  mapsBefore: Record<string, SpaceMap | null>;
}
