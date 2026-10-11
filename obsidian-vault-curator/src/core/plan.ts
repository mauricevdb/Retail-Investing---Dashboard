import { basename, dirname, extname, isInside, join, matchPath, normalize, relativeTo, sanitizePath, stem, uniquePath } from "./paths";
import { CheckedOp, PlanOp, Resource, SectionNode, SpaceMap } from "./types";

export interface VaultState {
  files: string[];
  folders: string[];
}

export interface PlanContext {
  spaceFolder: string;
  /** Vault inbox: files may be moved out of it into the space. */
  inboxFolder: string;
  archiveFolder: string;
  /** Paths the plan may not touch (generated canvas, index, map). */
  protectedPaths: string[];
  /** Managed sub-spaces: they can be moved as a whole, never entered. */
  lockedFolders: string[];
}

/** Simulated vault that remembers where each original file went. */
class Sim {
  files = new Map<string, string>(); // current path -> origin id
  folders = new Set<string>();

  constructor(state: VaultState) {
    for (const f of state.files) this.files.set(f, f);
    for (const d of state.folders) this.addFolder(d);
  }

  exists(p: string) {
    return this.files.has(p) || this.folders.has(p);
  }

  /** The existing path Claude meant, tolerating space-relative paths and dropped emoji. */
  find(raw: string | null, ctx: PlanContext): string | null {
    const resolved = resolvePath(raw, ctx);
    if (!raw || !resolved) return resolved;
    const plain = sanitizePath(normalize(raw));
    for (const p of [resolved, plain]) if (this.exists(p)) return p;
    const all = [...this.files.keys(), ...this.folders];
    return matchPath(resolved, all) ?? matchPath(plain, all) ?? resolved;
  }

  addFolder(p: string) {
    for (let d = p; d !== ""; d = dirname(d)) this.folders.add(d);
  }

  move(from: string, to: string) {
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
    } else {
      for (const [p, origin] of [...this.files]) {
        if (isInside(p, from)) {
          this.files.delete(p);
          this.files.set(to + p.slice(from.length), origin);
        }
      }
      for (const d of [...this.folders]) {
        if (isInside(d, from)) {
          this.folders.delete(d);
          this.folders.add(to + d.slice(from.length));
        }
      }
    }
    this.addFolder(dirname(to));
  }

  locations(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [p, origin] of this.files) out.set(origin, p);
    return out;
  }
}

/** Makes Claude's paths vault-relative: tolerates space-relative paths and leading slashes. */
export function resolvePath(raw: string | null, ctx: PlanContext): string | null {
  if (!raw) return null;
  const p = sanitizePath(normalize(raw));
  if (!p) return null;
  if (isInside(p, ctx.spaceFolder) || isInside(p, ctx.inboxFolder)) return p;
  return join(ctx.spaceFolder, p);
}

export function archiveTarget(source: string, ctx: PlanContext): string {
  return join(ctx.spaceFolder, ctx.archiveFolder, relativeTo(source, ctx.spaceFolder) || basename(source));
}

/** What the plugin needs to prepare the merge of handwritten material into a note. */
export interface IntegrationRequest {
  index: number;
  /** The note, as addressed at this point of the plan. */
  target: string;
  /** Where the note is today, or null when the plan creates it. */
  targetOrigin: string | null;
  sources: { path: string; origin: string }[];
}

export interface Fillers {
  /** Note body of a transcribe op, from the image's original path. */
  transcript?: (originalPath: string, currentPath: string) => string | null;
  /** Merged note of an integrate op, once prepared. */
  integration?: (req: IntegrationRequest) => { content: string; before: string | null; warning: string | null } | null;
}

export function transcriptTarget(image: string): string {
  return join(dirname(image), `${stem(image)} — transcription.md`);
}

/**
 * Validates every op against a simulated vault, in order. Invalid ops get an error and are
 * skipped by the simulation; so are ops the user deselected (`selected[i] === false`).
 * Targets are normalised in the returned ops (archive and transcribe targets are computed,
 * note names de-duplicated, file extensions preserved on moves).
 */
export function checkPlan(
  ops: PlanOp[],
  state: VaultState,
  ctx: PlanContext,
  selected?: boolean[],
  fill: Fillers = {},
): CheckedOp[] {
  const sim = new Sim(state);
  const integrated = new Set<string>();
  const protectedSet = new Set(ctx.protectedPaths);
  const archiveRoot = join(ctx.spaceFolder, ctx.archiveFolder);
  const inSpace = (p: string) => isInside(p, ctx.spaceFolder) && p !== ctx.spaceFolder;
  const locked = (p: string, allowSelf = false) => ctx.lockedFolders.some((l) => isInside(p, l) && !(allowSelf && p === l));

  return ops.map((raw, index) => {
    const op: CheckedOp = {
      ...raw,
      index,
      source: sim.find(raw.source, ctx),
      target: raw.kind === "append_note" ? sim.find(raw.target, ctx) : resolvePath(raw.target, ctx),
      error: null,
    };
    const fail = (error: string) => ({ ...op, error });
    const active = selected?.[index] !== false;

    switch (op.kind) {
      case "mkdir": {
        if (!op.target || !inSpace(op.target)) return fail("hors du dossier géré");
        if (locked(op.target)) return fail("dans un sous-espace géré à part");
        if (sim.files.has(op.target)) return fail("un fichier porte déjà ce nom");
        if (active) sim.addFolder(op.target);
        return op;
      }
      case "move":
      case "archive": {
        if (!op.source || !sim.exists(op.source)) return fail("source introuvable");
        if (!inSpace(op.source) && !isInside(op.source, ctx.inboxFolder)) return fail("source hors du dossier");
        if (protectedSet.has(op.source)) return fail("fichier généré par le plugin");
        if (locked(op.source, true)) return fail("dans un sous-espace géré à part");
        if (op.kind === "archive") {
          if (isInside(op.source, archiveRoot)) return fail("déjà archivé");
          op.target = uniquePath(archiveTarget(op.source, ctx), (p) => sim.exists(p));
        } else {
          if (!op.target || !inSpace(op.target)) return fail("destination hors du dossier");
          if (sim.files.has(op.source) && extname(op.target) !== extname(op.source)) {
            op.target = `${op.target}.${extname(op.source)}`.replace(/\.$/, "");
          }
          if (op.target === op.source) return fail("source et destination identiques");
          if (isInside(op.target, op.source)) return fail("dossier déplacé dans lui-même");
          if (sim.exists(op.target)) return fail("la destination existe déjà");
          if (protectedSet.has(op.target)) return fail("nom réservé au plugin");
          if (locked(op.target)) return fail("dans un sous-espace géré à part");
        }
        if (active) sim.move(op.source, op.target);
        return op;
      }
      case "create_note":
      case "transcribe": {
        if (op.kind === "transcribe") {
          if (!op.source || !sim.files.has(op.source)) return fail("image introuvable");
          op.target = op.target ?? transcriptTarget(op.source);
          if (!op.content?.trim() && fill.transcript) op.content = fill.transcript(sim.files.get(op.source)!, op.source);
          if (!op.content?.trim()) return fail("aucune transcription disponible");
        }
        if (!op.target || !inSpace(op.target)) return fail("note hors du dossier");
        if (locked(op.target)) return fail("dans un sous-espace géré à part");
        if (extname(op.target) !== "md") op.target = `${op.target}.md`;
        if (!op.content?.trim()) return fail("contenu vide");
        op.target = uniquePath(op.target, (p) => sim.exists(p) || protectedSet.has(p));
        if (active) {
          sim.files.set(op.target, `new:${index}`);
          sim.addFolder(dirname(op.target));
        }
        return op;
      }
      case "append_note": {
        if (!op.target || !sim.files.has(op.target)) return fail("note introuvable");
        if (extname(op.target) !== "md") return fail("seules les notes .md peuvent être complétées");
        if (protectedSet.has(op.target)) return fail("fichier généré par le plugin");
        if (locked(op.target)) return fail("dans un sous-espace géré à part");
        if (!op.content?.trim()) return fail("contenu vide");
        return op;
      }
      case "integrate": {
        const rawSources = raw.sources?.length ? raw.sources : raw.source ? [raw.source] : [];
        const sources = rawSources.map((x) => sim.find(x, ctx)).filter((x): x is string => !!x);
        op.source = null;
        op.sources = sources;
        if (!sources.length) return fail("aucun document à intégrer");
        const missing = sources.find((x) => !sim.files.has(x));
        if (missing) return fail(`document introuvable : ${missing}`);
        const found = raw.target ? sim.find(raw.target, ctx) : null;
        op.target = found && sim.files.has(found) ? found : op.target;
        if (!op.target || !inSpace(op.target)) return fail("fiche hors du dossier");
        if (extname(op.target) !== "md") op.target = `${op.target}.md`;
        if (protectedSet.has(op.target)) return fail("fichier généré par le plugin");
        if (locked(op.target)) return fail("dans un sous-espace géré à part");
        if (sim.folders.has(op.target)) return fail("un dossier porte ce nom");
        const origin = sim.files.get(op.target) ?? null;
        if (origin?.startsWith("new:")) return fail("fiche créée par une autre opération du plan");
        if (integrated.has(op.target)) return fail("une autre intégration vise déjà cette fiche");
        if (!op.content?.trim() && fill.integration) {
          const r = fill.integration({ index, target: op.target, targetOrigin: origin, sources: sources.map((x) => ({ path: x, origin: sim.files.get(x)! })) });
          if (r) Object.assign(op, { content: r.content, before: r.before, warning: r.warning });
        }
        if (!op.content?.trim()) return fail("fusion pas encore préparée : « Réviser » pour la relancer");
        if (active) {
          integrated.add(op.target);
          if (!origin) {
            sim.files.set(op.target, `new:${index}`);
            sim.addFolder(dirname(op.target));
          }
        }
        return op;
      }
      default:
        return fail(`opération inconnue « ${(op as PlanOp).kind} »`);
    }
  });
}

/** Where every original file (and every created note) ends up once `ops` run. */
export function finalLocations(ops: CheckedOp[], state: VaultState, selected?: boolean[]): Map<string, string> {
  const sim = new Sim(state);
  for (const op of ops) {
    if (op.error || selected?.[op.index] === false) continue;
    if ((op.kind === "move" || op.kind === "archive") && op.source && op.target) sim.move(op.source, op.target);
    if ((op.kind === "create_note" || op.kind === "transcribe") && op.target) sim.files.set(op.target, `new:${op.index}`);
    if (op.kind === "integrate" && op.target && !sim.files.has(op.target)) sim.files.set(op.target, `new:${op.index}`);
  }
  return sim.locations();
}

/**
 * Claude writes the map assuming its whole plan runs. When ops are rejected or
 * deselected, resource paths are rewritten to where the files really end up; resources
 * pointing at files that will not exist are dropped and reported.
 */
export function pathRewriter(ops: CheckedOp[], state: VaultState, selected: boolean[]): (path: string) => string | null {
  const intended = finalLocations(ops, state);
  const actual = finalLocations(ops, state, selected);
  const rewrite = new Map<string, string | null>();
  for (const [origin, path] of intended) rewrite.set(path, actual.get(origin) ?? null);
  const existing = new Set(actual.values());
  return (path) => (rewrite.has(path) ? rewrite.get(path)! : existing.has(path) ? path : null);
}

export function reconcileMap(
  map: SpaceMap,
  ops: CheckedOp[],
  state: VaultState,
  selected: boolean[],
): { map: SpaceMap; dropped: string[] } {
  const rewrite = pathRewriter(ops, state, selected);
  const existing = new Set(finalLocations(ops, state, selected).values());
  const dropped: string[] = [];

  const fix = (resources: Resource[]): Resource[] =>
    resources.flatMap((r) => {
      const path = rewrite(r.path);
      if (!path) {
        dropped.push(r.path);
        return [];
      }
      return [{ ...r, path }];
    });
  const fixFolder = (folder: string | null) => {
    if (!folder) return null;
    const fileInside = [...existing].some((p) => isInside(p, folder));
    return fileInside ? folder : null;
  };
  const fixSection = (m: SectionNode): SectionNode => ({
    ...m,
    folder: fixFolder(m.folder),
    resources: fix(m.resources),
    children: m.children.map(fixSection),
  });

  return {
    map: {
      ...map,
      sections: map.sections.map(fixSection),
      transverse: fix(map.transverse),
      keptDashboards: map.keptDashboards.map(rewrite).filter((p): p is string => !!p),
    },
    dropped,
  };
}

/** Applies a rename (file or folder) to every path stored in a map. */
export function renameInMap(map: SpaceMap, from: string, to: string): SpaceMap {
  const re = (p: string) => (isInside(p, from) ? to + p.slice(from.length) : p);
  const fixSection = (m: SectionNode): SectionNode => ({
    ...m,
    folder: m.folder ? re(m.folder) : null,
    resources: m.resources.map((r) => ({ ...r, path: re(r.path) })),
    children: m.children.map(fixSection),
  });
  return {
    ...map,
    folder: re(map.folder),
    sections: map.sections.map(fixSection),
    transverse: map.transverse.map((r) => ({ ...r, path: re(r.path) })),
    keptDashboards: map.keptDashboards.map(re),
  };
}

export function allSections(map: SpaceMap): SectionNode[] {
  return map.sections.flatMap((m) => [m, ...m.children]);
}

export function allResourcePaths(map: SpaceMap): Set<string> {
  return new Set([...allSections(map).flatMap((m) => m.resources.map((r) => r.path)), ...map.transverse.map((r) => r.path)]);
}

/**
 * Lines of the note as it was that cannot be found in the merged version: the merge must only
 * add. Returns them (trimmed); headings and list markers are compared without their prefix so
 * that promoting a line to a heading or a bullet is not counted as a loss.
 */
export function lostLines(before: string, after: string): string[] {
  const norm = (l: string) => l.trim().replace(/^(#+|[-*+]|\d+\.)\s+/, "").replace(/\s+/g, " ");
  const kept = new Set(after.split("\n").map(norm));
  const afterFlat = after.replace(/\s+/g, " ");
  return before
    .split("\n")
    .map(norm)
    .filter((l) => l.length > 2 && !kept.has(l) && !afterFlat.includes(l));
}
