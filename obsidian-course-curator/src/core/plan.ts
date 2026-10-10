import { basename, dirname, extname, isInside, join, matchPath, normalize, relativeTo, sanitizePath, stem, uniquePath } from "./paths";
import { CheckedOp, CourseMap, ModuleNode, PlanOp, Resource } from "./types";

export interface VaultState {
  files: string[];
  folders: string[];
}

export interface PlanContext {
  courseFolder: string;
  /** Vault inbox: files may be moved out of it into the course. */
  inboxFolder: string;
  archiveFolder: string;
  /** Paths the plan may not touch (generated canvas, index, map). */
  protectedPaths: string[];
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

  /** The existing path Claude meant, tolerating course-relative paths and dropped emoji. */
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

/** Makes Claude's paths vault-relative: tolerates course-relative paths and leading slashes. */
export function resolvePath(raw: string | null, ctx: PlanContext): string | null {
  if (!raw) return null;
  const p = sanitizePath(normalize(raw));
  if (!p) return null;
  if (isInside(p, ctx.courseFolder) || isInside(p, ctx.inboxFolder)) return p;
  return join(ctx.courseFolder, p);
}

export function archiveTarget(source: string, ctx: PlanContext): string {
  return join(ctx.courseFolder, ctx.archiveFolder, relativeTo(source, ctx.courseFolder) || basename(source));
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
  /** Supplies the note body of a transcribe op from the image's original path. */
  transcriptFor?: (originalPath: string, currentPath: string) => string | null,
): CheckedOp[] {
  const sim = new Sim(state);
  const protectedSet = new Set(ctx.protectedPaths);
  const archiveRoot = join(ctx.courseFolder, ctx.archiveFolder);
  const inCourse = (p: string) => isInside(p, ctx.courseFolder) && p !== ctx.courseFolder;

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
        if (!op.target || !inCourse(op.target)) return fail("dossier hors du cours");
        if (sim.files.has(op.target)) return fail("un fichier porte déjà ce nom");
        if (active) sim.addFolder(op.target);
        return op;
      }
      case "move":
      case "archive": {
        if (!op.source || !sim.exists(op.source)) return fail("source introuvable");
        if (!inCourse(op.source) && !isInside(op.source, ctx.inboxFolder)) return fail("source hors du cours");
        if (protectedSet.has(op.source)) return fail("fichier généré par le plugin");
        if (op.kind === "archive") {
          if (isInside(op.source, archiveRoot)) return fail("déjà archivé");
          op.target = uniquePath(archiveTarget(op.source, ctx), (p) => sim.exists(p));
        } else {
          if (!op.target || !inCourse(op.target)) return fail("destination hors du cours");
          if (sim.files.has(op.source) && extname(op.target) !== extname(op.source)) {
            op.target = `${op.target}.${extname(op.source)}`.replace(/\.$/, "");
          }
          if (op.target === op.source) return fail("source et destination identiques");
          if (isInside(op.target, op.source)) return fail("dossier déplacé dans lui-même");
          if (sim.exists(op.target)) return fail("la destination existe déjà");
          if (protectedSet.has(op.target)) return fail("nom réservé au plugin");
        }
        if (active) sim.move(op.source, op.target);
        return op;
      }
      case "create_note":
      case "transcribe": {
        if (op.kind === "transcribe") {
          if (!op.source || !sim.files.has(op.source)) return fail("image introuvable");
          op.target = op.target ?? transcriptTarget(op.source);
          if (!op.content?.trim() && transcriptFor) op.content = transcriptFor(sim.files.get(op.source)!, op.source);
          if (!op.content?.trim()) return fail("aucune transcription disponible");
        }
        if (!op.target || !inCourse(op.target)) return fail("note hors du cours");
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
        if (!op.content?.trim()) return fail("contenu vide");
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
  }
  return sim.locations();
}

/**
 * Claude writes the course map assuming its whole plan runs. When ops are rejected or
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
  map: CourseMap,
  ops: CheckedOp[],
  state: VaultState,
  selected: boolean[],
): { map: CourseMap; dropped: string[] } {
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
  const fixModule = (m: ModuleNode): ModuleNode => ({
    ...m,
    folder: fixFolder(m.folder),
    resources: fix(m.resources),
    children: m.children.map(fixModule),
  });

  return {
    map: {
      ...map,
      modules: map.modules.map(fixModule),
      transverse: fix(map.transverse),
      keptDashboards: map.keptDashboards.map(rewrite).filter((p): p is string => !!p),
    },
    dropped,
  };
}

/** Applies a rename (file or folder) to every path stored in a course map. */
export function renameInMap(map: CourseMap, from: string, to: string): CourseMap {
  const re = (p: string) => (isInside(p, from) ? to + p.slice(from.length) : p);
  const fixModule = (m: ModuleNode): ModuleNode => ({
    ...m,
    folder: m.folder ? re(m.folder) : null,
    resources: m.resources.map((r) => ({ ...r, path: re(r.path) })),
    children: m.children.map(fixModule),
  });
  return {
    ...map,
    folder: re(map.folder),
    modules: map.modules.map(fixModule),
    transverse: map.transverse.map((r) => ({ ...r, path: re(r.path) })),
    keptDashboards: map.keptDashboards.map(re),
  };
}

export function allModules(map: CourseMap): ModuleNode[] {
  return map.modules.flatMap((m) => [m, ...m.children]);
}

export function allResourcePaths(map: CourseMap): Set<string> {
  return new Set([...allModules(map).flatMap((m) => m.resources.map((r) => r.path)), ...map.transverse.map((r) => r.path)]);
}
