import { basename, join } from "./paths";

export type Backend = "claude-code" | "anthropic-api";
export type Intervention = "conservative" | "balanced" | "thorough";

/** A folder managed by the plugin. */
export interface SpaceConfig {
  folder: string;
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
  transcribeHandwriting: boolean;
  /** Pages of text extracted from each PDF for the digest. */
  pdfPages: number;
  /** Who the user is, so Claude can guess how a folder is used. */
  profile: string;
  /** House rules applied to every folder; editable. */
  guidelines: string;
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
  transcribeHandwriting: true,
  pdfPages: 4,
  profile: "Étudiant en master Data & Finance.",
  guidelines: DEFAULT_GUIDELINES,
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

export function newSpace(settings: CuratorSettings, folder: string, vaultName: string, instructions = ""): SpaceConfig {
  const name = spaceName(folder, vaultName);
  const fill = (pattern: string) => pattern.replace(/\{name\}|\{course\}/g, name);
  return {
    folder,
    instructions,
    canvas: join(folder, `${fill(settings.canvasName)}.canvas`),
    index: join(folder, `${fill(settings.indexName)}.md`),
    addedAt: new Date().toISOString(),
  };
}

/**
 * Settings saved by version 0.1 (course-only) are turned into spaces: every course folder that
 * already had a map keeps its dashboards and becomes a managed space.
 */
export function migrateSettings(raw: Record<string, unknown>, existingMaps: (folder: string) => boolean, folders: string[]): CuratorSettings {
  const s = { ...DEFAULT_SETTINGS, ...raw } as CuratorSettings & { coursesRoot?: string; transcribePhotos?: boolean; convention?: string; watchNewFiles?: boolean };
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
          instructions: "Dossier d'un cours du master Data & Finance.",
          canvas: join(folder, `${canvasPattern.replace(/\{course\}|\{name\}/g, name)}.canvas`),
          index: join(folder, `${indexPattern.replace(/\{course\}|\{name\}/g, name)}.md`),
          addedAt: new Date().toISOString(),
        };
      });
    s.canvasName = DEFAULT_SETTINGS.canvasName;
    s.indexName = DEFAULT_SETTINGS.indexName;
  }
  if (typeof s.transcribePhotos === "boolean") s.transcribeHandwriting = s.transcribePhotos;
  if (typeof s.watchNewFiles === "boolean") s.checkOnStart = s.watchNewFiles;
  delete s.coursesRoot;
  delete s.transcribePhotos;
  delete s.convention;
  delete s.watchNewFiles;
  return s;
}
