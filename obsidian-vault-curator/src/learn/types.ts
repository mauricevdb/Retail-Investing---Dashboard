// Synthesis pipeline for learning folders: a "lot" of raw documents (slides, exercise sheets,
// photos of the board or notebook, typed notes) becomes a set of study notes ("fiches") placed in
// the course's skill tree; the raw documents are archived once their content is fully integrated.

/** One raw document of the lot. */
export interface Source {
  /** Short id used in prompts: S1, S2… */
  id: string;
  path: string;
  kind: "pdf" | "image" | "markdown" | "text" | "notebook" | "data" | "other";
  size: number;
  mtime: number;
  /** Id of the note this photo (or PDF) is embedded in: `![[photo.jpg]]` in "Photos CM.md". */
  embeddedIn?: string;
}

/**
 * What happens to a document of the lot once the notes are written:
 * - integrate: its whole content goes into the notes, then it moves to the session's Sources folder;
 * - keep: session material not transcribed (notebook, data, annex): moves to Sources, linked from the tree;
 * - reference: course-wide reference (syllabus, textbook, lecture-notes volume): stays where it is, linked;
 * - note: already a structured study note: stays where it is and is a note of the skill tree (set by the plug-in);
 * - ignore: not course content (a tool's README, logs, configuration): left untouched, not in the tree.
 */
export type Disposition = "integrate" | "keep" | "reference" | "note" | "ignore";

/** Faithful, complete content of a source (not a summary). */
export interface Extract {
  sourceId: string;
  path: string;
  /** Full markdown transcription (page by page for PDFs). */
  text: string;
  /** Passages Claude could not read with certainty. */
  uncertain: string[];
  /** For photos: what the picture is (board, notebook page…), and its context. */
  description: string;
  /** Set when the user corrected the transcription by hand. */
  editedByUser?: boolean;
  /** Pages left out of a long PDF. */
  truncated?: string | null;
  /** Only skimmed (long PDF, data file): its content cannot be integrated, it can only be kept as a reference. */
  survey?: boolean;
}

export interface FichePlan {
  /** Stable id, e.g. "knn-principe"; becomes the skill-tree node id. */
  id: string;
  title: string;
  /** Vault path of the note. */
  path: string;
  /** keep: an existing study note placed in the skill tree as it is (nothing written). */
  action: "create" | "extend" | "keep";
  /** An existing note being extended that moves into the session's notes folder (set by the plug-in). */
  moveFrom?: string;
  objective: string;
  /** Sections, in order, each with what goes in it. */
  outline: string[];
  /** Sources feeding this note, with what each brings. */
  sources: { sourceId: string; what: string }[];
  /** Ids of notes that must be known first (new or existing). */
  dependsOn: string[];
  keywords: string[];
}

export interface ModulePlan {
  /** Existing section id of the course map, or a new one. */
  id: string;
  title: string;
  mode: "new" | "existing";
  /** Folder of the module, holding its notes. */
  folder: string;
  dependsOn: string[];
  summary: string;
}

/** What Claude proposes after reading everything: the user discusses it before anything is written. */
export interface SynthesisPlan {
  session: string;
  /** Language of the course material, used for the body of the notes ("English", "français"…). */
  language: string;
  summary: string;
  /** What each source brings, and problems seen (contradictions, missing statements, illegible parts). */
  sources: { sourceId: string; role: string; contributes: string; disposition: Disposition }[];
  issues: string[];
  module: ModulePlan;
  fiches: FichePlan[];
  /** How the course skill tree is reshaped around the new material (existing modules and notes included). */
  tree: CourseTreeChanges;
  questions: string[];
  changes: string[];
  preferences: string[];
}

export interface CourseTreeChanges {
  /** Every module of the course (new one included), in learning order. */
  moduleOrder: string[];
  /** Existing modules or notes whose prerequisites or summary change: dependsOn replaces the old list. */
  updates: { id: string; dependsOn: string[]; summary: string; why: string }[];
}

export interface WrittenFiche {
  plan: FichePlan;
  content: string;
  /** Content of the note before (extend), null when created. */
  before: string | null;
}

export interface Coverage {
  sourceId: string;
  path: string;
  covered: boolean;
  /** Kept in place on purpose (reference, notebook, data): nothing to check. */
  kept?: boolean;
  missing: { item: string; fiche: string }[];
}
