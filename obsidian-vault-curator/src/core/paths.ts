// Vault paths are always "/"-separated and relative to the vault root, without leading slash.

export function normalize(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

export function join(...parts: (string | null | undefined)[]): string {
  return normalize(parts.filter((p) => p).join("/"));
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export function stem(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  return i <= 0 ? base : base.slice(0, i);
}

/** True when `path` is `folder` itself or lies below it. "" is the vault root. */
export function isInside(path: string, folder: string): boolean {
  if (folder === "") return true;
  return path === folder || path.startsWith(folder + "/");
}

export function relativeTo(path: string, folder: string): string {
  if (folder === "") return path;
  return path === folder ? "" : path.slice(folder.length + 1);
}

/** Characters Obsidian refuses in file names, plus those that break wikilinks. */
const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

export function sanitizeSegment(name: string): string {
  return name
    .replace(FORBIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
}

/** Sanitises every segment of a path; never produces "..". */
export function sanitizePath(path: string): string {
  return normalize(path)
    .split("/")
    .map(sanitizeSegment)
    .filter((s) => s !== "" && s !== "..")
    .join("/");
}

/** Appends " (2)", " (3)"... before the extension until the path is free. */
export function uniquePath(path: string, taken: (p: string) => boolean): string {
  if (!taken(path)) return path;
  const dir = dirname(path);
  const ext = extname(path);
  const base = stem(path);
  for (let n = 2; ; n++) {
    const candidate = join(dir, ext ? `${base} (${n}).${ext}` : `${base} (${n})`);
    if (!taken(candidate)) return candidate;
  }
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/** Loose identity of a path: Claude sometimes drops emoji, changes case or Unicode normalisation. */
export function pathKey(path: string): string {
  return normalize(path)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/.]+/gu, "");
}

/** Finds which of `candidates` Claude meant by `path` (exact first, then loose; null if ambiguous). */
export function matchPath(path: string, candidates: Iterable<string>): string | null {
  const list = [...candidates];
  if (list.includes(path)) return path;
  const key = pathKey(path);
  const hits = list.filter((c) => pathKey(c) === key);
  return hits.length === 1 ? hits[0] : null;
}

/** Short stable hash (FNV-1a, base 36) for cache keys and file names. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
