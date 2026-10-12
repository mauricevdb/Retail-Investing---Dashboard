import { basename, stem } from "./paths";
import { DocType, Resource, SectionNode, SectionStatus, SpaceMap } from "./types";

// JSON Canvas 1.0 (https://jsoncanvas.org). Only the fields we use.
export interface CanvasNode {
  id: string;
  type: "text" | "file" | "group" | "link";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  label?: string;
  color?: string;
}
export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
}
export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** Every node/edge the plugin owns starts with this prefix; anything else is the user's. */
export const OWN = "cc-";
// Node ids kept from version 0.1 so existing canvases keep their layout and colours.
const HEADER = `${OWN}course`;
const SECTION = `${OWN}m-`;

const STATUS_COLOR: Record<SectionStatus, string | undefined> = { todo: undefined, doing: "3", done: "4" };
export const ROLE_ICON: Record<DocType, string> = {
  cours: "📄",
  exercices: "✏️",
  corrige: "✅",
  notes: "📝",
  manuscrit: "📓",
  photo: "📷",
  lecture: "📚",
  reference: "📘",
  rapport: "📑",
  presentation: "🖥️",
  donnees: "📊",
  code: "💻",
  admin: "🗂️",
  correspondance: "✉️",
  planning: "🧭",
  journal: "📅",
  modele: "🧩",
  dashboard: "🗺️",
  fiche: "📒",
  archive: "🗄️",
  autre: "📎",
};
const ROLE_ORDER = Object.keys(ROLE_ICON) as DocType[];

const CARD_W = 400;
const CHILD_W = 360;
const GAP_X = 120;
const GAP_Y = 160;
const PER_ROW = 4;
const LINE_H = 24;

export function statusFromColor(color: string | undefined): SectionStatus {
  if (color === "4") return "done";
  if (color === "3" || color === "2") return "doing";
  return "todo";
}

function link(r: Resource): string {
  const label = (r.label || stem(r.path)).replace(/[[\]|]/g, " ");
  return `[[${r.path}|${label}]]`;
}

export function resourceLines(resources: Resource[]): string[] {
  const sorted = [...resources].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.label.localeCompare(b.label, "fr", { numeric: true }),
  );
  return sorted.map((r) => `- ${ROLE_ICON[r.role] ?? "📎"} ${link(r)}`);
}

function sectionText(m: SectionNode, number: string): string {
  const parts = [`## ${number} · ${m.title}`];
  if (m.summary) parts.push(m.summary);
  if (m.keywords.length) parts.push(`**Mots-clés** : ${m.keywords.join(" · ")}`);
  const lines = resourceLines(m.resources);
  if (lines.length) parts.push(lines.join("\n"));
  return parts.join("\n\n");
}

/** Rough rendered height of a markdown text node. */
export function estimateHeight(text: string, width: number): number {
  const charsPerLine = Math.max(20, Math.floor((width - 36) / 8));
  let lines = 0;
  for (const line of text.split("\n")) {
    const visible = line.replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, "$1");
    const isHeading = /^#{1,3} /.test(line);
    lines += Math.max(1, Math.ceil(visible.length / charsPerLine)) * (isHeading ? 1.5 : 1);
  }
  return Math.round(lines * LINE_H + 50);
}

/** Dependency level: 0 without dependencies, else one more than the deepest dependency. */
export function levels(sections: SectionNode[]): Map<string, number> {
  const byId = new Map(sections.map((m) => [m.id, m]));
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    const m = byId.get(id);
    if (!m || stack.has(id)) return -1; // unknown id or cycle: ignore the edge
    stack.add(id);
    const lvl = 1 + Math.max(-1, ...m.dependsOn.map((p) => visit(p, stack)));
    stack.delete(id);
    memo.set(id, lvl);
    return lvl;
  };
  for (const m of sections) visit(m.id, new Set());
  return memo;
}

export interface CanvasLinks {
  index: string;
  unfiled?: string[];
  /** Managed sub-folders: name and dashboard path. */
  subspaces?: { name: string; canvas: string }[];
}

/**
 * Builds the dashboard of a managed folder. A title card on top, then one card per section.
 * When sections depend on each other (prerequisites, phases), they are banded by level with
 * arrows, like a skill tree; otherwise they sit on a grid in their order. Sub-sections are
 * stacked inside their section's group. When `previous` is the canvas generated last time,
 * positions and sizes the user changed are kept, node colours (progress) are kept, and every
 * node or edge the user added by hand is carried over untouched.
 */
export function buildCanvas(
  map: SpaceMap,
  links: CanvasLinks,
  previous?: CanvasData,
  options: { keepLayout: boolean } = { keepLayout: true },
): CanvasData {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const prev = new Map((previous?.nodes ?? []).map((n) => [n.id, n]));

  // Header row: title card, then side cards to its right.
  const title = map.dashboardTitle ? `# ${map.name} — ${map.dashboardTitle}` : `# ${map.name}`;
  const headerText = [
    title,
    map.summary,
    map.purpose ? `**À quoi ça sert** : ${map.purpose}` : "",
    `🧾 [[${links.index}|Index et mode d'emploi]]${map.keptDashboards.map((d) => ` · 🗺️ [[${d}|${stem(d)}]]`).join("")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const headerW = 640;
  nodes.push({ id: HEADER, type: "text", x: 0, y: 0, width: headerW, height: estimateHeight(headerText, headerW), text: headerText, color: "6" });

  let headerBottom = nodes[0].height;
  let sideX = headerW + GAP_X;
  const side = (id: string, text: string, color: string) => {
    const node: CanvasNode = { id, type: "text", x: sideX, y: 0, width: CARD_W, height: estimateHeight(text, CARD_W), text, color };
    nodes.push(node);
    headerBottom = Math.max(headerBottom, node.height);
    sideX += CARD_W + GAP_X;
  };
  if (links.subspaces?.length) {
    side(`${OWN}subspaces`, `### 🗂️ Sous-dossiers organisés\n\n${links.subspaces.map((s) => `- [[${s.canvas}|${s.name}]]`).join("\n")}`, "5");
  }
  if (map.transverse.length) side(`${OWN}transverse`, `### 📚 Ressources transverses\n\n${resourceLines(map.transverse).join("\n")}`, "5");
  if (links.unfiled?.length) {
    const shown = links.unfiled.slice(0, 30).map((p) => `- [[${p}|${stem(p)}]]`);
    if (links.unfiled.length > 30) shown.push(`- … et ${links.unfiled.length - 30} autres`);
    side(`${OWN}unfiled`, `### 📥 À classer\n\n${shown.join("\n")}`, "1");
  }
  const legend = "**Suivi** — colore une section :\n🟨 jaune = en cours · 🟩 vert = terminé / maîtrisé";
  nodes.push({ id: `${OWN}legend`, type: "text", x: -CARD_W - GAP_X, y: 0, width: CARD_W, height: 110, text: legend });

  // Sections: banded by dependency level when links are meaningful, else one grid.
  const ids = new Set(map.sections.map((m) => m.id));
  const linked = map.linkKind !== "none" && map.sections.some((m) => m.dependsOn.some((p) => ids.has(p) && p !== m.id));
  const lvl = linked ? levels(map.sections) : new Map<string, number>();
  const bands = new Map<number, SectionNode[]>();
  for (const m of map.sections) {
    const l = Math.max(0, lvl.get(m.id) ?? 0);
    bands.set(l, [...(bands.get(l) ?? []), m]);
  }
  const numbering = new Map(map.sections.map((m, i) => [m.id, String(i + 1).padStart(2, "0")]));

  let y = headerBottom + GAP_Y;
  for (const band of [...bands.keys()].sort((a, b) => a - b)) {
    const row0 = bands.get(band)!;
    for (let start = 0; start < row0.length; start += PER_ROW) {
      const row = row0.slice(start, start + PER_ROW).map((m) => layoutSection(m, numbering.get(m.id)!));
      const rowWidth = row.reduce((w, r) => w + r.width, 0) + (row.length - 1) * GAP_X;
      let x = Math.round(headerW / 2 - rowWidth / 2);
      let rowHeight = 0;
      for (const r of row) {
        for (const n of r.nodes) nodes.push({ ...n, x: n.x + x, y: n.y + y });
        rowHeight = Math.max(rowHeight, r.height);
        x += r.width + GAP_X;
      }
      y += rowHeight + GAP_Y;
    }
  }

  // Arrows: dependency -> section, and the title card points at the roots.
  if (linked) {
    for (const m of map.sections) {
      for (const p of m.dependsOn) {
        if (ids.has(p) && p !== m.id) edges.push(edge(`${OWN}e-${p}--${m.id}`, `${SECTION}${p}`, `${SECTION}${m.id}`));
      }
    }
    for (const m of map.sections.filter((m) => (lvl.get(m.id) ?? 0) === 0)) {
      edges.push(edge(`${OWN}e-course--${m.id}`, HEADER, `${SECTION}${m.id}`, "6"));
    }
  }
  // Prerequisites between sub-sections (study notes of a course), within or across sections.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const children = map.sections.flatMap((m) => m.children);
  const deps = new Map(children.map((c) => [c.id, c.dependsOn.filter((d) => d !== c.id)]));
  // Transitive reduction: no arrow A → C when C already depends on A through another prerequisite.
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    for (const d of deps.get(from) ?? []) {
      if (d === to) return true;
      if (!seen.has(d)) {
        seen.add(d);
        if (reaches(d, to, seen)) return true;
      }
    }
    return false;
  };
  for (const c of children) {
    for (const p of deps.get(c.id) ?? []) {
      if ((deps.get(c.id) ?? []).some((q) => q !== p && reaches(q, p))) continue;
      if (nodeIds.has(`${SECTION}${p}`) && nodeIds.has(`${SECTION}${c.id}`)) {
        edges.push(edge(`${OWN}e-${p}--${c.id}`, `${SECTION}${p}`, `${SECTION}${c.id}`, "2"));
      }
    }
  }

  // Keep what the user did on the previous version.
  for (const n of nodes) {
    const old = prev.get(n.id);
    if (!old) continue;
    if (n.id.startsWith(SECTION)) n.color = old.color;
    if (!options.keepLayout) continue;
    n.x = old.x;
    n.y = old.y;
    n.width = old.width;
    if (n.type === "group") n.height = Math.max(n.height, old.height);
  }
  if (options.keepLayout && previous) placeNewcomers(map, nodes, prev);
  const ours = new Set(nodes.map((n) => n.id));
  const userNodes = (previous?.nodes ?? []).filter((n) => !n.id.startsWith(OWN));
  const allIds = new Set([...ours, ...userNodes.map((n) => n.id)]);
  const userEdges = (previous?.edges ?? []).filter((e) => !e.id.startsWith(OWN) && allIds.has(e.fromNode) && allIds.has(e.toNode));

  return { nodes: [...nodes, ...userNodes], edges: [...edges, ...userEdges] };
}

/**
 * With a kept layout, sections and sub-sections that did not exist last time would land where the
 * fresh layout puts them, on top of nodes the user placed. New sub-sections go at the bottom of
 * their section's group (which grows); new sections go on a new row below everything.
 */
function placeNewcomers(map: SpaceMap, nodes: CanvasNode[], prev: Map<string, CanvasNode>) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shift = (ids: string[], dx: number, dy: number) => {
    for (const id of ids) {
      const n = byId.get(id);
      if (n) (n.x += dx), (n.y += dy);
    }
  };
  const bottom = (ns: CanvasNode[]) => Math.max(...ns.map((n) => n.y + n.height));

  for (const m of map.sections) {
    const group = byId.get(`${OWN}g-${m.id}`)!;
    if (!prev.has(group.id)) continue;
    const card = byId.get(`${SECTION}${m.id}`)!;
    const placed = [card, ...m.children.filter((c) => prev.has(`${SECTION}${c.id}`)).map((c) => byId.get(`${SECTION}${c.id}`)!)];
    let y = bottom(placed) + 30;
    for (const c of m.children.filter((c) => !prev.has(`${SECTION}${c.id}`))) {
      const n = byId.get(`${SECTION}${c.id}`)!;
      n.x = group.x + 40;
      n.y = y;
      y += n.height + 30;
    }
    group.height = Math.max(group.height, y - group.y);
  }

  const fresh = map.sections.filter((m) => !prev.has(`${OWN}g-${m.id}`));
  const kept = nodes.filter((n) => prev.has(n.id));
  if (!fresh.length || !kept.length) return;
  const groups = kept.filter((n) => n.type === "group");
  const left = groups.length ? Math.min(...groups.map((n) => n.x)) : 0;
  let y = bottom(kept) + GAP_Y;
  for (let start = 0; start < fresh.length; start += PER_ROW) {
    let x = left;
    let rowHeight = 0;
    for (const m of fresh.slice(start, start + PER_ROW)) {
      const group = byId.get(`${OWN}g-${m.id}`)!;
      const ids = [group.id, `${SECTION}${m.id}`, ...m.children.map((c) => `${SECTION}${c.id}`)];
      shift(ids, x - group.x, y - group.y);
      rowHeight = Math.max(rowHeight, group.height);
      x += CARD_W + 40 + GAP_X;
    }
    y += rowHeight + GAP_Y;
  }
}

function edge(id: string, from: string, to: string, color?: string): CanvasEdge {
  return { id, fromNode: from, toNode: to, fromSide: "bottom", toSide: "top", toEnd: "arrow", ...(color ? { color } : {}) };
}

/** Places a section card (+ its sub-sections) inside a group; returns the group height. */
/**
 * Lays out a section card and its sub-sections inside a group, at (0,0); returns the nodes and the
 * group size. When sub-sections depend on each other (the study notes of a course module), they
 * form a small skill tree: one row per prerequisite level, side by side within a row. Otherwise
 * they are stacked.
 */
function layoutSection(m: SectionNode, number: string): { nodes: CanvasNode[]; width: number; height: number } {
  const pad = 20;
  const gap = 40;
  const text = sectionText(m, number);
  const cardH = estimateHeight(text, CARD_W);
  const siblings = new Set(m.children.map((c) => c.id));
  const tree = m.children.some((c) => c.dependsOn.some((d) => siblings.has(d) && d !== c.id));
  const lvl = tree ? levels(m.children.map((c) => ({ ...c, dependsOn: c.dependsOn.filter((d) => siblings.has(d)) }))) : new Map<string, number>();
  const rows = new Map<number, { c: SectionNode; i: number }[]>();
  m.children.forEach((c, i) => {
    const l = tree ? Math.max(0, lvl.get(c.id) ?? 0) : i;
    rows.set(l, [...(rows.get(l) ?? []), { c, i }]);
  });
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const width = Math.max(CARD_W, widest * CHILD_W + (widest - 1) * gap) + 2 * pad;
  const children: CanvasNode[] = [];
  let cy = pad + 30 + cardH + (tree ? 80 : 30);
  for (const l of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(l)!;
    const rowW = row.length * CHILD_W + (row.length - 1) * gap;
    let cx = Math.round((width - rowW) / 2);
    let rowH = 0;
    for (const { c, i } of row) {
      const ct = sectionText(c, `${number}.${i + 1}`).replace(/^## /, "### ");
      const h = estimateHeight(ct, CHILD_W);
      children.push({ id: `${SECTION}${c.id}`, type: "text", x: cx, y: cy, width: CHILD_W, height: h, text: ct, color: STATUS_COLOR[c.status ?? "todo"] });
      cx += CHILD_W + gap;
      rowH = Math.max(rowH, h);
    }
    cy += rowH + (tree ? 80 : 30);
  }
  const height = cy - (tree ? 50 : 0);
  return {
    nodes: [
      { id: `${OWN}g-${m.id}`, type: "group", x: 0, y: 0, width, height, label: `${number} · ${m.title}` },
      { id: `${SECTION}${m.id}`, type: "text", x: Math.round((width - CARD_W) / 2), y: pad + 30, width: CARD_W, height: cardH, text, color: STATUS_COLOR[m.status ?? "todo"] },
      ...children,
    ],
    width,
    height,
  };
}

/** Reads section progress back from a canvas the plugin generated. */
export function readStatuses(canvas: CanvasData): Map<string, SectionStatus> {
  const out = new Map<string, SectionStatus>();
  for (const n of canvas.nodes) {
    if (n.id.startsWith(SECTION)) out.set(n.id.slice(SECTION.length), statusFromColor(n.color));
  }
  return out;
}

/** Plain-text digest of any canvas (for prompts about existing dashboards). */
export function describeCanvas(canvas: CanvasData, max = 4000): string {
  const parts = canvas.nodes.map((n) => {
    if (n.type === "text") return `[texte] ${n.text?.replace(/\s+/g, " ").slice(0, 300)}`;
    if (n.type === "file") return `[fichier] ${n.file}`;
    if (n.type === "group") return `[groupe] ${n.label ?? ""}`;
    return `[${n.type}] ${basename(n.file ?? n.label ?? "")}`;
  });
  parts.push(`(${canvas.nodes.length} nœuds, ${canvas.edges.length} liens)`);
  return parts.join("\n").slice(0, max);
}

export function parseCanvas(raw: string): CanvasData | null {
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.nodes)) return null;
    return { nodes: data.nodes, edges: Array.isArray(data.edges) ? data.edges : [] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session canvas: the entry point of one session (week) of a course.

export interface SessionLinks {
  /** The course skill tree, to go back up. */
  courseCanvas: string;
  /** Raw documents not fully integrated yet, still lying in the session folder. */
  pending: string[];
}

const FICHE_W = 420;
const FICHE_H = 300;
const SOURCE_W = 300;
const SOURCE_H = 220;

/**
 * One canvas per session, placed in the session folder: the session's study notes (outputs) as
 * note previews, ordered by prerequisites, then its sources (inputs: transcriptions, slides,
 * exercise sheets, notebooks). Positions, sizes and colours the user changed are kept, as well as
 * anything added by hand.
 */
export function buildSessionCanvas(section: SectionNode, links: SessionLinks, previous?: CanvasData): CanvasData {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const fiches = section.children.filter((c) => c.resources.some((r) => r.role === "fiche"));
  const sources = section.resources.filter((r) => r.role !== "dashboard" && r.role !== "fiche");

  const header = [
    `# ${section.title}`,
    section.summary,
    `↩ [[${links.courseCanvas}|Skill tree du cours]]`,
    "**Suivi** — colore une fiche : 🟨 jaune = en cours · 🟩 vert = maîtrisée",
  ]
    .filter(Boolean)
    .join("\n\n");
  const headerW = 2 * FICHE_W + 60;
  nodes.push({ id: `${OWN}session`, type: "text", x: 0, y: 0, width: headerW, height: estimateHeight(header, headerW), text: header, color: "6" });

  // Outputs: one row per prerequisite level, side by side within a row.
  const siblings = new Set(fiches.map((f) => f.id));
  const lvl = levels(fiches.map((f) => ({ ...f, dependsOn: f.dependsOn.filter((d) => siblings.has(d)) })));
  const rows = new Map<number, SectionNode[]>();
  for (const f of fiches) {
    const l = Math.max(0, lvl.get(f.id) ?? 0);
    rows.set(l, [...(rows.get(l) ?? []), f]);
  }
  const gap = 60;
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const width = Math.max(headerW, widest * FICHE_W + (widest - 1) * gap);
  const pad = 30;
  let y = nodes[0].height + 80;
  const groupTop = y;
  y += pad + 30;
  for (const l of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(l)!;
    let x = Math.round((width - (row.length * FICHE_W + (row.length - 1) * gap)) / 2);
    for (const f of row) {
      const file = f.resources.find((r) => r.role === "fiche")!.path;
      nodes.push({ id: `${OWN}f-${f.id}`, type: "file", file, x, y, width: FICHE_W, height: FICHE_H, color: STATUS_COLOR[f.status ?? "todo"] });
      x += FICHE_W + gap;
    }
    y += FICHE_H + 80;
  }
  if (fiches.length) {
    nodes.push({ id: `${OWN}g-fiches`, type: "group", x: -pad, y: groupTop, width: width + 2 * pad, height: y - groupTop - 80 + pad, label: "Fiches" });
  }
  // Direct prerequisites only (transitive reduction), so the tree stays readable.
  const deps = new Map(fiches.map((f) => [f.id, f.dependsOn.filter((d) => siblings.has(d) && d !== f.id)]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
    (deps.get(from) ?? []).some((d) => d === to || (!seen.has(d) && (seen.add(d), reaches(d, to, seen))));
  for (const [id, ds] of deps) {
    for (const d of ds) {
      if (ds.some((o) => o !== d && reaches(o, d))) continue;
      edges.push(edge(`${OWN}e-${d}--${id}`, `${OWN}f-${d}`, `${OWN}f-${id}`));
    }
  }

  // Inputs: what the notes were made from, archived in the session's sources folder.
  if (sources.length || links.pending.length) {
    const top = y + 40;
    const perRow = Math.max(1, Math.floor((width + gap) / (SOURCE_W + gap)));
    const items = [...sources].sort((a, b) => (a.role === "archive" ? -1 : b.role === "archive" ? 1 : a.label.localeCompare(b.label, "fr", { numeric: true })));
    let i = 0;
    let sy = top + pad + 30;
    for (const r of items) {
      const col = i % perRow;
      if (i && col === 0) sy += SOURCE_H + 40;
      nodes.push({ id: `${OWN}s-${r.path}`, type: "file", file: r.path, x: col * (SOURCE_W + gap), y: sy, width: SOURCE_W, height: SOURCE_H });
      i++;
    }
    let bottom = items.length ? sy + SOURCE_H : top + pad + 30;
    if (links.pending.length) {
      const text = `### ⚠️ Pas encore intégré\nCes documents restent dans le dossier de la séance : leur contenu n'est pas entièrement dans les fiches.\n\n${links.pending.map((p) => `- [[${p}|${stem(p)}]]`).join("\n")}`;
      const h = estimateHeight(text, CARD_W);
      nodes.push({ id: `${OWN}pending`, type: "text", x: 0, y: bottom + 40, width: CARD_W, height: h, text, color: "1" });
      bottom += 40 + h;
    }
    nodes.push({ id: `${OWN}g-sources`, type: "group", x: -pad, y: top, width: width + 2 * pad, height: bottom - top + pad, label: "Sources" });
  }

  return mergePrevious({ nodes, edges }, previous);
}

/** Keeps what the user changed on the previous canvas: positions, sizes, colours, own nodes and edges. */
function mergePrevious(next: CanvasData, previous?: CanvasData): CanvasData {
  if (!previous) return next;
  const prev = new Map(previous.nodes.map((n) => [n.id, n]));
  const nodes = next.nodes.map((n) => {
    const p = prev.get(n.id);
    return p ? { ...n, x: p.x, y: p.y, width: p.width, height: p.height, ...(p.color !== undefined ? { color: p.color } : {}) } : n;
  });
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of previous.nodes) if (!n.id.startsWith(OWN)) nodes.push(n), ids.add(n.id);
  const edges = [...next.edges, ...previous.edges.filter((e) => !e.id.startsWith(OWN) && ids.has(e.fromNode) && ids.has(e.toNode))];
  return { nodes, edges };
}
