import { allSections } from "./plan";
import { slugify } from "./paths";
import { DOC_TYPES, DocType, Resource, SectionNode, SpaceMap } from "./types";

export interface NewSection {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  dependsOn: string[];
  parentId: string | null;
  folder: string | null;
}

export interface Assignment {
  path: string;
  /** null = folder-wide (transverse) resource. */
  sectionId: string | null;
  role: DocType;
  label: string;
}

export interface MapPatch {
  newSections: NewSection[];
  assignments: Assignment[];
  /** Keywords to add to existing sections. */
  keywordUpdates: { sectionId: string; keywords: string[] }[];
}

/**
 * Applies an incremental patch. Existing sections and resources are never removed; a resource
 * already listed is re-assigned. Assignments to unknown sections fall back to transverse.
 */
export function applyPatch(map: SpaceMap, input: MapPatch): SpaceMap {
  const next: SpaceMap = structuredClone(map);
  const patch: MapPatch = structuredClone(input);
  const ids = new Set(allSections(next).map((m) => m.id));
  const existing = new Set(ids);

  for (const ns of patch.newSections) {
    // Reusing an existing id means "this section": just enrich it.
    if (ns.id && existing.has(ns.id)) {
      patch.keywordUpdates.push({ sectionId: ns.id, keywords: ns.keywords });
      continue;
    }
    let id = ns.id || slugify(ns.title);
    const asked = id;
    while (ids.has(id)) id = `${id}-b`;
    ids.add(id);
    const node: SectionNode = {
      id,
      title: ns.title,
      summary: ns.summary,
      keywords: ns.keywords,
      dependsOn: ns.dependsOn.filter((p) => ids.has(p)),
      folder: ns.folder,
      resources: [],
      children: [],
    };
    const parent = ns.parentId ? next.sections.find((m) => m.id === ns.parentId) : undefined;
    if (parent) parent.children.push(node);
    else next.sections.push(node);
    if (asked !== id) {
      for (const a of patch.assignments) if (a.sectionId === asked) a.sectionId = id;
    }
  }

  const sections = new Map(allSections(next).map((m) => [m.id, m]));
  for (const u of patch.keywordUpdates) {
    const m = sections.get(u.sectionId);
    if (m) m.keywords = [...new Set([...m.keywords, ...u.keywords])];
  }

  for (const a of patch.assignments) {
    for (const m of sections.values()) m.resources = m.resources.filter((r) => r.path !== a.path);
    next.transverse = next.transverse.filter((r) => r.path !== a.path);
    const resource = { path: a.path, role: a.role, label: a.label };
    const target = a.sectionId ? sections.get(a.sectionId) : undefined;
    if (target) target.resources.push(resource);
    else next.transverse.push(resource);
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

/** Copies user-owned state (progress) from the previous map onto a freshly generated one. */
export function carryStatuses(fresh: SpaceMap, previous: SpaceMap | null): SpaceMap {
  if (!previous) return fresh;
  const old = new Map(allSections(previous).map((m) => [m.id, m.status]));
  const fix = (m: SectionNode): SectionNode => ({ ...m, status: m.status ?? old.get(m.id), children: m.children.map(fix) });
  return { ...fresh, sections: fresh.sections.map(fix) };
}

/** Lists each transcription note right after its source, in the same section (or transverse). */
export function attachTranscripts(map: SpaceMap, transcripts: { image: string; note: string }[]): SpaceMap {
  const next: SpaceMap = structuredClone(map);
  const listed = new Set([...allSections(next).flatMap((m) => m.resources), ...next.transverse].map((r) => r.path));
  const lists = [...allSections(next).map((m) => m.resources), next.transverse];
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

// ---------------------------------------------------------------------------
// Version 0.1 maps (course-only) → version 2.

const OLD_ROLES: Record<string, DocType> = { tableau: "manuscrit", cahier: "manuscrit", annale: "exercices", syllabus: "planning", formulaire: "reference" };

export function normaliseRole(role: string): DocType {
  if ((DOC_TYPES as readonly string[]).includes(role)) return role as DocType;
  return OLD_ROLES[role] ?? "autre";
}

interface V1Module {
  id: string;
  title: string;
  summary: string;
  concepts: string[];
  prerequisites: string[];
  folder: string | null;
  resources: Resource[];
  children: V1Module[];
  status?: SectionNode["status"];
}

/** Reads a stored map, upgrading a version 0.1 course map on the fly. */
export function upgradeMap(raw: unknown): SpaceMap | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.version === 2) return m as unknown as SpaceMap;
  if (m.version !== 1) return null;
  const fixRes = (rs: Resource[]) => (rs ?? []).map((r) => ({ ...r, role: normaliseRole(r.role) }));
  const conv = (mod: V1Module): SectionNode => ({
    id: mod.id,
    title: mod.title,
    summary: mod.summary,
    keywords: mod.concepts ?? [],
    dependsOn: mod.prerequisites ?? [],
    folder: mod.folder,
    resources: fixRes(mod.resources),
    children: (mod.children ?? []).map(conv),
    ...(mod.status ? { status: mod.status } : {}),
  });
  return {
    version: 2,
    name: String(m.course ?? ""),
    folder: String(m.folder ?? ""),
    kind: "cours",
    summary: String(m.summary ?? ""),
    purpose: "Réviser et suivre un cours du master.",
    usage: "",
    conventions: "",
    preferences: [],
    dashboardTitle: "Skill tree",
    linkKind: "prerequisite",
    sections: ((m.modules as V1Module[]) ?? []).map(conv),
    transverse: fixRes(m.transverse as Resource[]),
    keptDashboards: (m.keptDashboards as string[]) ?? [],
    updatedAt: String(m.updatedAt ?? new Date().toISOString()),
  };
}
