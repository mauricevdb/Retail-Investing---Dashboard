import { basename, stem } from "./paths";
import { CourseMap, DocType, ModuleNode, ModuleStatus, Resource } from "./types";

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

const STATUS_COLOR: Record<ModuleStatus, string | undefined> = { todo: undefined, doing: "3", done: "4" };
const ROLE_ICON: Record<DocType, string> = {
  cours: "📄",
  exercices: "✏️",
  corrige: "✅",
  notes: "📝",
  tableau: "📷",
  cahier: "📓",
  annale: "🎯",
  syllabus: "🧭",
  formulaire: "🧮",
  lecture: "📚",
  dashboard: "🗺️",
  autre: "📎",
};
const ROLE_ORDER: DocType[] = ["cours", "notes", "tableau", "cahier", "exercices", "corrige", "annale", "formulaire", "lecture", "syllabus", "dashboard", "autre"];

const MODULE_W = 400;
const CHILD_W = 360;
const GAP_X = 120;
const GAP_Y = 160;
const PER_ROW = 4;
const LINE_H = 24;

export function statusFromColor(color: string | undefined): ModuleStatus {
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

function moduleText(m: ModuleNode, number: string): string {
  const parts = [`## ${number} · ${m.title}`];
  if (m.summary) parts.push(m.summary);
  if (m.concepts.length) parts.push(`**Concepts** : ${m.concepts.join(" · ")}`);
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

/** Skill-tree level: 0 without prerequisites, else one more than the deepest prerequisite. */
export function levels(modules: ModuleNode[]): Map<string, number> {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    const m = byId.get(id);
    if (!m || stack.has(id)) return -1; // unknown id or cycle: ignore the edge
    stack.add(id);
    const lvl = 1 + Math.max(-1, ...m.prerequisites.map((p) => visit(p, stack)));
    stack.delete(id);
    memo.set(id, lvl);
    return lvl;
  };
  for (const m of modules) visit(m.id, new Set());
  return memo;
}

/**
 * Builds the course dashboard. Layout: a title card on top, then the modules as a skill tree
 * (one band per prerequisite level, wrapped every PER_ROW modules), each module in a group with
 * its sub-modules stacked below. When `previous` is the canvas generated last time, positions
 * and sizes the user changed are kept, node colours (progress) are kept, and every node or edge
 * the user added by hand is carried over untouched.
 */
export function buildCanvas(
  map: CourseMap,
  links: { index: string; unfiled?: string[] },
  previous?: CanvasData,
  options: { keepLayout: boolean } = { keepLayout: true },
): CanvasData {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const prev = new Map((previous?.nodes ?? []).map((n) => [n.id, n]));

  // Header: course card, transverse resources, legend.
  const headerText = [
    `# ${map.course}`,
    map.summary,
    `🧾 [[${links.index}|Index du cours]]${map.keptDashboards.map((d) => ` · 🗺️ [[${d}|${stem(d)}]]`).join("")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const headerW = 640;
  nodes.push({ id: `${OWN}course`, type: "text", x: 0, y: 0, width: headerW, height: estimateHeight(headerText, headerW), text: headerText, color: "6" });

  let headerBottom = nodes[0].height;
  if (map.transverse.length) {
    const text = `### 📚 Ressources transverses\n\n${resourceLines(map.transverse).join("\n")}`;
    const node: CanvasNode = { id: `${OWN}transverse`, type: "text", x: headerW + GAP_X, y: 0, width: MODULE_W, height: estimateHeight(text, MODULE_W), text, color: "5" };
    nodes.push(node);
    headerBottom = Math.max(headerBottom, node.height);
  }
  if (links.unfiled?.length) {
    const shown = links.unfiled.slice(0, 30).map((p) => `- [[${p}|${stem(p)}]]`);
    if (links.unfiled.length > 30) shown.push(`- … et ${links.unfiled.length - 30} autres`);
    const text = `### 📥 À classer\n\n${shown.join("\n")}`;
    const node: CanvasNode = { id: `${OWN}unfiled`, type: "text", x: headerW + GAP_X + (map.transverse.length ? MODULE_W + GAP_X : 0), y: 0, width: MODULE_W, height: estimateHeight(text, MODULE_W), text, color: "1" };
    nodes.push(node);
    headerBottom = Math.max(headerBottom, node.height);
  }
  const legend = "**Progression** — colore un module :\n🟨 jaune = en cours · 🟩 vert = maîtrisé";
  nodes.push({ id: `${OWN}legend`, type: "text", x: -MODULE_W - GAP_X, y: 0, width: MODULE_W, height: 110, text: legend });

  // Modules, banded by prerequisite level.
  const lvl = levels(map.modules);
  const bands = new Map<number, ModuleNode[]>();
  for (const m of map.modules) {
    const l = Math.max(0, lvl.get(m.id) ?? 0);
    bands.set(l, [...(bands.get(l) ?? []), m]);
  }
  const numbering = new Map(map.modules.map((m, i) => [m.id, String(i + 1).padStart(2, "0")]));

  let y = headerBottom + GAP_Y;
  for (const band of [...bands.keys()].sort((a, b) => a - b)) {
    const mods = bands.get(band)!;
    for (let start = 0; start < mods.length; start += PER_ROW) {
      const row = mods.slice(start, start + PER_ROW);
      const rowWidth = row.length * (MODULE_W + 40) + (row.length - 1) * GAP_X;
      let x = Math.round(headerW / 2 - rowWidth / 2);
      let rowHeight = 0;
      for (const m of row) {
        const height = placeModule(m, numbering.get(m.id)!, x, y, nodes);
        rowHeight = Math.max(rowHeight, height);
        x += MODULE_W + 40 + GAP_X;
      }
      y += rowHeight + GAP_Y;
    }
  }

  // Skill-tree edges: prerequisite -> module. Without any prerequisite, chain modules in order.
  const ids = new Set(map.modules.map((m) => m.id));
  const anyPrereq = map.modules.some((m) => m.prerequisites.some((p) => ids.has(p) && p !== m.id));
  if (anyPrereq) {
    for (const m of map.modules) {
      for (const p of m.prerequisites) {
        if (ids.has(p) && p !== m.id) edges.push(edge(`${OWN}e-${p}--${m.id}`, `${OWN}m-${p}`, `${OWN}m-${m.id}`));
      }
    }
    for (const m of map.modules.filter((m) => (lvl.get(m.id) ?? 0) === 0)) {
      edges.push(edge(`${OWN}e-course--${m.id}`, `${OWN}course`, `${OWN}m-${m.id}`, "6"));
    }
  } else if (map.modules.length) {
    edges.push(edge(`${OWN}e-course--${map.modules[0].id}`, `${OWN}course`, `${OWN}m-${map.modules[0].id}`, "6"));
  }

  // Keep what the user did on the previous version.
  for (const n of nodes) {
    const old = prev.get(n.id);
    if (!old) continue;
    if (n.id.startsWith(`${OWN}m-`)) n.color = old.color;
    if (!options.keepLayout) continue;
    n.x = old.x;
    n.y = old.y;
    n.width = old.width;
    if (n.type === "group") n.height = Math.max(n.height, old.height);
  }
  const ours = new Set(nodes.map((n) => n.id));
  const userNodes = (previous?.nodes ?? []).filter((n) => !n.id.startsWith(OWN));
  const allIds = new Set([...ours, ...userNodes.map((n) => n.id)]);
  const userEdges = (previous?.edges ?? []).filter((e) => !e.id.startsWith(OWN) && allIds.has(e.fromNode) && allIds.has(e.toNode));

  return { nodes: [...nodes, ...userNodes], edges: [...edges, ...userEdges] };
}

function edge(id: string, from: string, to: string, color?: string): CanvasEdge {
  return { id, fromNode: from, toNode: to, fromSide: "bottom", toSide: "top", toEnd: "arrow", ...(color ? { color } : {}) };
}

/** Places a module card (+ its sub-modules) inside a group; returns the group height. */
function placeModule(m: ModuleNode, number: string, x: number, y: number, nodes: CanvasNode[]): number {
  const pad = 20;
  const text = moduleText(m, number);
  const cardH = estimateHeight(text, MODULE_W);
  const children: CanvasNode[] = [];
  let cy = y + pad + 30 + cardH + 30;
  m.children.forEach((c, i) => {
    const ct = moduleText(c, `${number}.${i + 1}`).replace(/^## /, "### ");
    const h = estimateHeight(ct, CHILD_W);
    children.push({ id: `${OWN}m-${c.id}`, type: "text", x: x + pad + 20, y: cy, width: CHILD_W, height: h, text: ct, color: STATUS_COLOR[c.status ?? "todo"] });
    cy += h + 30;
  });
  const groupH = cy - y;
  nodes.push({ id: `${OWN}g-${m.id}`, type: "group", x, y, width: MODULE_W + 40, height: groupH, label: `${number} · ${m.title}` });
  nodes.push({ id: `${OWN}m-${m.id}`, type: "text", x: x + pad, y: y + pad + 30, width: MODULE_W, height: cardH, text, color: STATUS_COLOR[m.status ?? "todo"] });
  nodes.push(...children);
  return groupH;
}

/** Reads module progress back from a canvas the plugin generated. */
export function readStatuses(canvas: CanvasData): Map<string, ModuleStatus> {
  const out = new Map<string, ModuleStatus>();
  for (const n of canvas.nodes) {
    if (n.id.startsWith(`${OWN}m-`)) out.set(n.id.slice(`${OWN}m-`.length), statusFromColor(n.color));
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
