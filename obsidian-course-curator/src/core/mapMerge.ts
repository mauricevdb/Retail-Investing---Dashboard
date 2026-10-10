import { allModules } from "./plan";
import { slugify } from "./paths";
import { CourseMap, DocType, ModuleNode } from "./types";

export interface NewModule {
  id: string;
  title: string;
  summary: string;
  concepts: string[];
  prerequisites: string[];
  parentId: string | null;
  folder: string | null;
}

export interface Assignment {
  path: string;
  /** null = course-wide (transverse) resource. */
  moduleId: string | null;
  role: DocType;
  label: string;
}

export interface MapPatch {
  newModules: NewModule[];
  assignments: Assignment[];
  /** Concepts to add to existing modules. */
  conceptUpdates: { moduleId: string; concepts: string[] }[];
}

/**
 * Applies an incremental patch. Existing modules and resources are never removed; a resource
 * already listed is re-assigned. Assignments to unknown modules fall back to transverse.
 */
export function applyPatch(map: CourseMap, input: MapPatch): CourseMap {
  const next: CourseMap = structuredClone(map);
  const patch: MapPatch = structuredClone(input);
  const ids = new Set(allModules(next).map((m) => m.id));

  const existing = new Set(ids);
  for (const nm of patch.newModules) {
    // Reusing an existing id means "this module": just enrich it.
    if (nm.id && existing.has(nm.id)) {
      patch.conceptUpdates.push({ moduleId: nm.id, concepts: nm.concepts });
      continue;
    }
    let id = nm.id || slugify(nm.title);
    const asked = id;
    while (ids.has(id)) id = `${id}-b`;
    ids.add(id);
    const node: ModuleNode = {
      id,
      title: nm.title,
      summary: nm.summary,
      concepts: nm.concepts,
      prerequisites: nm.prerequisites.filter((p) => ids.has(p)),
      folder: nm.folder,
      resources: [],
      children: [],
    };
    const parent = nm.parentId ? next.modules.find((m) => m.id === nm.parentId) : undefined;
    if (parent) parent.children.push(node);
    else next.modules.push(node);
    if (asked !== id) {
      for (const a of patch.assignments) if (a.moduleId === asked) a.moduleId = id;
    }
  }

  const modules = new Map(allModules(next).map((m) => [m.id, m]));
  for (const u of patch.conceptUpdates) {
    const m = modules.get(u.moduleId);
    if (m) m.concepts = [...new Set([...m.concepts, ...u.concepts])];
  }

  for (const a of patch.assignments) {
    for (const m of modules.values()) m.resources = m.resources.filter((r) => r.path !== a.path);
    next.transverse = next.transverse.filter((r) => r.path !== a.path);
    const resource = { path: a.path, role: a.role, label: a.label };
    const target = a.moduleId ? modules.get(a.moduleId) : undefined;
    if (target) target.resources.push(resource);
    else next.transverse.push(resource);
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

/** Copies user-owned state (progress) from the previous map onto a freshly generated one. */
export function carryStatuses(fresh: CourseMap, previous: CourseMap | null): CourseMap {
  if (!previous) return fresh;
  const old = new Map(allModules(previous).map((m) => [m.id, m.status]));
  const fix = (m: ModuleNode): ModuleNode => ({ ...m, status: m.status ?? old.get(m.id), children: m.children.map(fix) });
  return { ...fresh, modules: fresh.modules.map(fix) };
}

/** Lists each transcription note right after its photo, in the same module (or transverse). */
export function attachTranscripts(map: CourseMap, transcripts: { image: string; note: string }[]): CourseMap {
  const next: CourseMap = structuredClone(map);
  const listed = new Set([...allModules(next).flatMap((m) => m.resources), ...next.transverse].map((r) => r.path));
  const lists = [...allModules(next).map((m) => m.resources), next.transverse];
  for (const { image, note } of transcripts) {
    if (listed.has(note)) continue;
    const list = lists.find((l) => l.some((r) => r.path === image));
    if (!list) continue;
    const i = list.findIndex((r) => r.path === image);
    list.splice(i + 1, 0, { path: note, role: "notes", label: `Transcription — ${list[i].label}` });
    listed.add(note);
  }
  return next;
}
