import { basename, dirname, extname, isInside, join, relativeTo } from "./paths";
import { CuratorSettings, mapPath, SpaceConfig, spaceName } from "./settings";
import { FileKind, VaultFile } from "./types";

export interface SpaceInventory {
  config: SpaceConfig;
  name: string;
  folder: string;
  /** Every file of the space, minus the plugin's outputs, the archive, ignored folders and nested spaces. */
  files: VaultFile[];
  /** Sub-folders of the space (same exclusions). */
  folders: string[];
  /** Managed folders inside this one: they are organised separately and treated as single items. */
  subspaces: SpaceConfig[];
  /** Existing canvases and notes that look like a dashboard / MOC / index. */
  dashboards: string[];
  generated: { canvas: string; index: string; map: string };
  hasMap: boolean;
  structure: StructureSignals;
}

export interface StructureSignals {
  fileCount: number;
  subfolderCount: number;
  maxDepth: number;
  /** Files sitting directly in the managed folder. */
  looseFiles: number;
  /** Share of files that live in a sub-folder (0-1): a rough "already organised" indicator. */
  filedRatio: number;
  /** File count by kind, e.g. { pdf: 12, markdown: 30 }. */
  kinds: Record<string, number>;
}

export interface VaultScan {
  spaces: SpaceInventory[];
  inbox: VaultFile[];
}

const KINDS: Record<string, FileKind> = {
  md: "markdown",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  heic: "image",
  canvas: "canvas",
  docx: "office",
  doc: "office",
  pptx: "office",
  ppt: "office",
  odt: "office",
  xlsx: "data",
  xls: "data",
  csv: "data",
  json: "data",
  parquet: "data",
  py: "code",
  r: "code",
  ipynb: "code",
  js: "code",
  ts: "code",
  sql: "code",
};

export function fileKind(path: string): FileKind {
  return KINDS[extname(path)] ?? "other";
}

const DASHBOARD_NAME = /dashboard|skill.?tree|\bmoc\b|index|sommaire|overview|carte|roadmap|plan du cours|tableau de bord|accueil|home/i;

export function looksLikeDashboardName(path: string): boolean {
  return fileKind(path) === "canvas" || (fileKind(path) === "markdown" && DASHBOARD_NAME.test(basename(path)));
}

export function fingerprint(file: VaultFile): string {
  return `${file.size}:${Math.round(file.mtime)}`;
}

/** True when a path is or crosses a folder the user asked to ignore (matched by name, at any depth). */
export function isIgnored(path: string, settings: CuratorSettings): boolean {
  const names = new Set(settings.ignoredFolders.map((f) => f.trim()).filter(Boolean));
  return path.split("/").some((seg) => names.has(seg));
}

export function scanVault(files: VaultFile[], folders: string[], settings: CuratorSettings, vaultName = "Vault"): VaultScan {
  const inboxPath = settings.inboxFolder;
  const inbox = files.filter((f) => isInside(f.path, inboxPath));
  const spaces = [...settings.spaces]
    .sort((a, b) => a.folder.localeCompare(b.folder))
    .map((config) => inventory(config, files, folders, settings, vaultName));
  return { spaces, inbox };
}

function inventory(config: SpaceConfig, files: VaultFile[], folders: string[], settings: CuratorSettings, vaultName: string): SpaceInventory {
  const { folder } = config;
  const generated = { canvas: config.canvas, index: config.index, map: mapPath(folder) };
  const archive = join(folder, settings.archiveFolder);
  const nested = settings.spaces.filter((s) => s.folder !== folder && isInside(s.folder, folder));
  // Only the outermost nested spaces are listed as sub-spaces.
  const subspaces = nested.filter((s) => !nested.some((o) => o !== s && isInside(s.folder, o.folder)));
  // In a course, each session's sources folder holds raw documents already integrated into notes.
  const sources = config.mode === "learning" && settings.sourcesFolder ? settings.sourcesFolder : null;
  const excluded = (p: string) =>
    isInside(p, archive) ||
    (sources !== null && relativeTo(p, folder).split("/").slice(0, -1).includes(sources)) ||
    isInside(p, settings.inboxFolder) ||
    isIgnored(p, settings) ||
    nested.some((s) => isInside(p, s.folder)) ||
    basename(p).startsWith(".");

  const own = new Set(Object.values(generated));
  const all = files.filter((f) => isInside(f.path, folder));
  const spaceFiles = all.filter((f) => !own.has(f.path) && !excluded(f.path));
  const subfolders = folders.filter((f) => isInside(f, folder) && f !== folder && !excluded(f));

  return {
    config,
    name: spaceName(folder, vaultName),
    folder,
    files: spaceFiles,
    folders: subfolders,
    subspaces,
    dashboards: spaceFiles.filter((f) => looksLikeDashboardName(f.path)).map((f) => f.path),
    generated,
    hasMap: all.some((f) => f.path === generated.map) || files.some((f) => f.path === generated.map),
    structure: structureSignals(folder, spaceFiles, subfolders),
  };
}

function structureSignals(folder: string, files: VaultFile[], subfolders: string[]): StructureSignals {
  const depth = (p: string) => relativeTo(p, folder).split("/").length - 1;
  const looseFiles = files.filter((f) => depth(f.path) === 0).length;
  const kinds: Record<string, number> = {};
  for (const f of files) kinds[fileKind(f.path)] = (kinds[fileKind(f.path)] ?? 0) + 1;
  return {
    fileCount: files.length,
    subfolderCount: subfolders.length,
    maxDepth: files.reduce((m, f) => Math.max(m, depth(f.path)), 0),
    looseFiles,
    filedRatio: files.length ? (files.length - looseFiles) / files.length : 0,
    kinds,
  };
}

/** Folders the user could add: top-level folders not managed, not ignored, not the inbox. */
export function candidateFolders(folders: string[], settings: CuratorSettings): string[] {
  const managed = new Set(settings.spaces.map((s) => s.folder));
  return folders
    .filter((f) => dirname(f) === "" && !managed.has(f) && !isIgnored(f, settings) && f !== settings.inboxFolder && !f.startsWith("."))
    .sort((a, b) => a.localeCompare(b));
}
