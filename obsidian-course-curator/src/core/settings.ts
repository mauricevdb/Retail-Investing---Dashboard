export type Backend = "claude-code" | "anthropic-api";
export type Intervention = "conservative" | "balanced" | "thorough";

export interface CuratorSettings {
  backend: Backend;
  /** Path to the `claude` executable; empty = auto-detect. */
  claudePath: string;
  apiKey: string;
  /** Model used to build structures and plans (the hard reasoning). */
  planModel: string;
  /** Model used to read and summarise individual files (bulk work). */
  digestModel: string;
  /** Seconds before a Claude call is abandoned. */
  timeoutSec: number;
  /** Parallel digest calls. */
  concurrency: number;
  /** Files per digest call. */
  batchSize: number;

  /** Folder holding one sub-folder per course; "" = vault root. */
  coursesRoot: string;
  /** Vault-level drop zone for documents whose course is unknown. */
  inboxFolder: string;
  /** Top-level folders that are not courses (comma separated in the UI). */
  ignoredFolders: string[];
  /** Name of the archive folder created inside each course. Nothing is ever deleted. */
  archiveFolder: string;
  /** Generated file names; {course} is replaced by the course folder name. */
  canvasName: string;
  indexName: string;

  intervention: Intervention;
  renameUnclearFiles: boolean;
  transcribePhotos: boolean;
  /** Pages of text extracted from each PDF for the digest. */
  pdfPages: number;
  /** Folder convention given to Claude; editable. */
  convention: string;
  /** Notify when new documents appear in a course. */
  watchNewFiles: boolean;
}

export const DEFAULT_CONVENTION = `{course}/
├── {course} — Skill tree.canvas    (généré : dashboard du cours)
├── {course} — Index.md             (généré : sommaire en texte)
├── 00 Admin/        syllabus, planning, modalités d'évaluation
├── 01 <Module>/     un dossier par module/chapitre, numéroté dans l'ordre du cours
│   ├── Cours/       slides, polycopiés
│   ├── Exercices/   TD, TP, énoncés et corrigés
│   ├── Notes/       prises de notes .md, transcriptions
│   └── Images/      photos du tableau ou du cahier
├── 90 Examens/      annales, partiels, corrigés
├── 95 Ressources/   formulaires, lectures, références transverses
└── 99 Archive/      anciens dashboards, doublons (rien n'est supprimé)
Les sous-dossiers d'un module ne sont créés que s'ils contiennent au moins 3 fichiers ;
en dessous, les fichiers restent à la racine du module.`;

export const DEFAULT_SETTINGS: CuratorSettings = {
  backend: "claude-code",
  claudePath: "",
  apiKey: "",
  planModel: "claude-opus-5-5",
  digestModel: "claude-sonnet-5-5",
  timeoutSec: 600,
  concurrency: 2,
  batchSize: 6,
  coursesRoot: "",
  inboxFolder: "📥 Inbox",
  ignoredFolders: ["Templates", "Attachments", "_templates", "Excalidraw"],
  archiveFolder: "99 Archive",
  canvasName: "{course} — Skill tree",
  indexName: "{course} — Index",
  intervention: "balanced",
  renameUnclearFiles: true,
  transcribePhotos: true,
  pdfPages: 4,
  convention: DEFAULT_CONVENTION,
  watchNewFiles: true,
};

export function generatedNames(settings: CuratorSettings, courseFolderName: string) {
  const fill = (pattern: string) => pattern.replace(/\{course\}/g, courseFolderName);
  return {
    canvas: `${fill(settings.canvasName)}.canvas`,
    index: `${fill(settings.indexName)}.md`,
    map: "_curator.json",
  };
}
