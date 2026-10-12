import { basename, join } from "./paths";

export type Backend = "claude-code" | "anthropic-api";
export type Intervention = "conservative" | "balanced" | "thorough";
export type HandwritingMode = "integrate" | "separate" | "off";

/**
 * learning: courses and the like — raw material is synthesised into study notes and a skill tree,
 * then archived. files: any other folder — documents are filed and renamed.
 */
export type SpaceMode = "learning" | "files";

/** A folder managed by the plugin. */
export interface SpaceConfig {
  folder: string;
  mode: SpaceMode;
  /**
   * Learning folders only: "course" (one course, one skill tree) or "programme" (a folder of courses,
   * one sub-folder per course: each course gets its own skill tree).
   */
  level?: "course" | "programme";
  /** What the user said about this folder when adding it (optional). */
  instructions: string;
  /** Generated dashboard paths (kept here so renames and legacy names survive). */
  canvas: string;
  index: string;
  addedAt: string;
}

export interface CuratorSettings {
  backend: Backend;
  /** Path to the `claude` executable; empty = auto-detect. */
  claudePath: string;
  apiKey: string;
  /** Model used to understand folders and build plans (the hard reasoning). */
  planModel: string;
  /** Model used to read and summarise individual files (bulk work). */
  digestModel: string;
  /** Seconds before a Claude call is abandoned. */
  timeoutSec: number;
  /** Parallel digest calls. */
  concurrency: number;
  /** Files per digest call. */
  batchSize: number;

  spaces: SpaceConfig[];
  /** Vault-level drop zone for documents whose folder is unknown. */
  inboxFolder: string;
  /** Folders never read nor touched (templates, attachments…), by name. */
  ignoredFolders: string[];
  /** Name of the archive folder created inside each space. Nothing is ever deleted. */
  archiveFolder: string;
  /** Generated file names for new spaces; {name} is replaced by the folder name. */
  canvasName: string;
  indexName: string;

  intervention: Intervention;
  renameUnclearFiles: boolean;
  /**
   * Handwritten material (photos of a board or notebook, scans): integrate its transcribed content
   * into the matching note, keep the transcription as a separate note next to it, or leave it alone.
   */
  handwriting: HandwritingMode;
  /** Pages of text extracted from each PDF for the digest. */
  pdfPages: number;
  /** Who the user is, so Claude can guess how a folder is used. */
  profile: string;
  /** House rules applied to every folder; editable. */
  guidelines: string;
  /** Vault-level archive of version 0.4/0.5 (sources now go to each session's own sources folder). */
  archiveRoot: string;
  /**
   * Layout of a course session: <session>/<fichesFolder>/ holds the study notes (outputs),
   * <session>/<sourcesFolder>/ the raw documents once integrated (inputs), <session>/<session>.canvas
   * the synthesis linking both.
   */
  fichesFolder: string;
  sourcesFolder: string;
  /** Language of the study notes: that of the course material ("auto"), or forced. */
  ficheLanguage: "auto" | "fr" | "en";
  /** Model used to transcribe photos of boards and notebooks (the hardest reading). */
  transcriptionModel: string;
  /** Second pass that checks each photo transcription against the image. */
  verifyTranscriptions: boolean;
  /** Pages of a PDF read in full by the synthesis (beyond, the rest is skipped and reported). */
  maxPdfPages: number;
  /** How a study note is laid out; Claude adapts it to the content. */
  ficheTemplate: string;
  /** Look for new material when Obsidian starts. */
  checkOnStart: boolean;
  /** …and open the aggregation right away instead of only notifying. */
  aggregateOnStart: boolean;
}

export const DEFAULT_GUIDELINES = `- Numéroter les dossiers qui ont un ordre naturel (« 01 Introduction », « 02 … ») ; ne pas numéroter ceux qui n'en ont pas.
- Trois niveaux de dossiers au maximum sous le dossier géré.
- Pas de dossier pour moins de 3 fichiers : en dessous, les fichiers restent au niveau parent.
- Noms courts et en français, sans abréviations obscures.
- Rien n'est supprimé : ce qui est obsolète ou en double va dans l'archive.`;

export const DEFAULT_FICHE_TEMPLATE = `# <Titre de la notion>
> **Objectif** : ce qu'on doit savoir faire après cette fiche. **Prérequis** : liens vers les fiches nécessaires.

## Intuition
Le problème que la notion résout et l'idée en deux ou trois phrases.

## Définitions et notations

## Résultats et formules
Formules en LaTeX, avec les hypothèses et le sens de chaque terme.

## Méthode / algorithme
Étapes numérotées, complexité si pertinente.

## Exemples
Les exemples traités au tableau ou en cours, rédigés pas à pas.

## Pièges et remarques

## À retenir
3 à 6 points.

## Pour s'entraîner
Liens vers les exercices corrigés correspondants.

## Sources
Liens vers les documents d'origine (archivés).`;

export const DEFAULT_SETTINGS: CuratorSettings = {
  backend: "claude-code",
  claudePath: "",
  apiKey: "",
  planModel: "claude-opus-5-5",
  digestModel: "claude-sonnet-5-5",
  timeoutSec: 600,
  concurrency: 2,
  batchSize: 6,
  spaces: [],
  inboxFolder: "📥 Inbox",
  ignoredFolders: ["Templates", "_templates", "Attachments", "Excalidraw"],
  archiveFolder: "99 Archive",
  canvasName: "{name} — Dashboard",
  indexName: "{name} — Index",
  intervention: "balanced",
  renameUnclearFiles: true,
  handwriting: "integrate",
  pdfPages: 4,
  profile: "Étudiant en master Data & Finance.",
  guidelines: DEFAULT_GUIDELINES,
  archiveRoot: "Archive",
  fichesFolder: "Fiches",
  sourcesFolder: "Sources",
  ficheLanguage: "auto",
  transcriptionModel: "claude-opus-5-5",
  verifyTranscriptions: true,
  maxPdfPages: 80,
  ficheTemplate: DEFAULT_FICHE_TEMPLATE,
  checkOnStart: true,
  aggregateOnStart: false,
};

export const MAP_FILE = "_curator.json";

export function mapPath(folder: string): string {
  return join(folder, MAP_FILE);
}

export function spaceName(folder: string, vaultName: string): string {
  return folder === "" ? vaultName : basename(folder);
}

export function newSpace(settings: CuratorSettings, folder: string, vaultName: string, instructions = "", mode: SpaceMode = "files", level?: SpaceConfig["level"]): SpaceConfig {
  const name = spaceName(folder, vaultName);
  const fill = (pattern: string) => pattern.replace(/\{name\}|\{course\}/g, name);
  return {
    folder,
    mode,
    ...(mode === "learning" ? { level: level ?? guessLevel(instructions) } : {}),
    instructions,
    canvas: mode === "learning" && (level ?? guessLevel(instructions)) === "course" ? courseCanvasPath(folder, name) : join(folder, `${fill(settings.canvasName)}.canvas`),
    index: join(folder, `${fill(settings.indexName)}.md`),
    addedAt: new Date().toISOString(),
  };
}

/** A course's skill tree comes first in its folder: it is where one starts. */
export function courseCanvasPath(folder: string, name: string): string {
  return join(folder, `00 Skill tree — ${name}.canvas`);
}

/** A learning folder described as holding several courses ("un sous-dossier par cours", "mes cours de master"…). */
export function guessLevel(instructions: string): "course" | "programme" {
  return /(sous-dossiers?|dossiers?) par (cours|mati[eè]re)|un (sous-)?dossier par|mes cours|cours de (mon )?master|ensemble de cours|plusieurs cours|one (sub)?folder per course/i.test(instructions)
    ? "programme"
    : "course";
}

/**
 * Settings saved by version 0.1 (course-only) are turned into spaces: every course folder that
 * already had a map keeps its dashboards and becomes a managed space.
 */
export function migrateSettings(raw: Record<string, unknown>, existingMaps: (folder: string) => boolean, folders: string[]): CuratorSettings {
  const s = { ...DEFAULT_SETTINGS, ...raw } as CuratorSettings & {
    coursesRoot?: string;
    transcribePhotos?: boolean;
    transcribeHandwriting?: boolean;
    convention?: string;
    watchNewFiles?: boolean;
  };
  if (!Array.isArray(raw.spaces) && typeof s.coursesRoot === "string") {
    const root = s.coursesRoot;
    const canvasPattern = (raw.canvasName as string | undefined) ?? "{course} — Skill tree";
    const indexPattern = (raw.indexName as string | undefined) ?? "{course} — Index";
    s.spaces = folders
      .filter((f) => f !== root && (root === "" ? !f.includes("/") : f.startsWith(`${root}/`) && !f.slice(root.length + 1).includes("/")))
      .filter((f) => existingMaps(f))
      .map((folder) => {
        const name = basename(folder);
        return {
          folder,
          mode: "learning" as SpaceMode,
          instructions: "Dossier d'un cours du master Data & Finance.",
          canvas: join(folder, `${canvasPattern.replace(/\{course\}|\{name\}/g, name)}.canvas`),
          index: join(folder, `${indexPattern.replace(/\{course\}|\{name\}/g, name)}.md`),
          addedAt: new Date().toISOString(),
        };
      });
    s.canvasName = DEFAULT_SETTINGS.canvasName;
    s.indexName = DEFAULT_SETTINGS.indexName;
  }
  const transcribe = s.transcribeHandwriting ?? s.transcribePhotos;
  if (transcribe === false && raw.handwriting === undefined) s.handwriting = "off";
  if (typeof s.watchNewFiles === "boolean") s.checkOnStart = s.watchNewFiles;
  delete s.coursesRoot;
  delete s.transcribePhotos;
  delete s.transcribeHandwriting;
  delete s.convention;
  delete s.watchNewFiles;
  return s;
}
