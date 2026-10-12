// Synthesis pipeline for learning folders: a "lot" of raw documents (slides, exercise sheets,
// photos of the board or notebook, typed notes) becomes a set of study notes ("fiches") placed in
// the course's skill tree; the raw documents are archived once their content is fully integrated.

/** One raw document of the lot. */
export interface Source {
  /** Short id used in prompts: S1, S2… */
  id: string;
  path: string;
  kind: "pdf" | "image" | "markdown" | "text" | "other";
  size: number;
  mtime: number;
}

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
}

export interface FichePlan {
  /** Stable id, e.g. "knn-principe"; becomes the skill-tree node id. */
  id: string;
  title: string;
  /** Vault path of the note. */
  path: string;
  action: "create" | "extend";
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
  summary: string;
  /** What each source brings, and problems seen (contradictions, missing statements, illegible parts). */
  sources: { sourceId: string; role: string; contributes: string }[];
  issues: string[];
  module: ModulePlan;
  fiches: FichePlan[];
  questions: string[];
  changes: string[];
  preferences: string[];
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
  missing: { item: string; fiche: string }[];
}
