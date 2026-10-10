import { resourceLines } from "./canvas";
import { stem } from "./paths";
import { CourseMap, ModuleNode } from "./types";

export const START = "<!-- course-curator:start -->";
export const END = "<!-- course-curator:end -->";

function moduleSection(m: ModuleNode, number: string, depth: number): string {
  const status = m.status === "done" ? " ✅" : m.status === "doing" ? " 🟨" : "";
  const parts = [`${"#".repeat(depth)} ${number} · ${m.title}${status}`];
  if (m.summary) parts.push(m.summary);
  if (m.concepts.length) parts.push(`**Concepts** : ${m.concepts.join(" · ")}`);
  const lines = resourceLines(m.resources);
  if (lines.length) parts.push(lines.join("\n"));
  m.children.forEach((c, i) => parts.push(moduleSection(c, `${number}.${i + 1}`, depth + 1)));
  return parts.join("\n\n");
}

/** Markdown twin of the canvas: readable on mobile, searchable, works with backlinks. */
export function renderIndexBody(map: CourseMap, canvasPath: string, unfiled: string[]): string {
  const parts = [`# ${map.course}`];
  if (map.summary) parts.push(map.summary);
  parts.push(`> [!tip] Dashboard visuel : [[${canvasPath}|${stem(canvasPath)}]]`);
  if (map.keptDashboards.length) parts.push(`Anciens dashboards conservés : ${map.keptDashboards.map((d) => `[[${d}|${stem(d)}]]`).join(" · ")}`);
  if (map.transverse.length) parts.push(`## 📚 Ressources transverses\n\n${resourceLines(map.transverse).join("\n")}`);
  map.modules.forEach((m, i) => parts.push(moduleSection(m, String(i + 1).padStart(2, "0"), 2)));
  if (unfiled.length) parts.push(`## 📥 À classer\n\n${unfiled.map((p) => `- [[${p}|${stem(p)}]]`).join("\n")}`);
  parts.push(`<small>Généré par Course Curator le ${map.updatedAt.slice(0, 10)}. Le texte écrit hors des balises est conservé.</small>`);
  return parts.join("\n\n");
}

/** Replaces the generated block, keeping whatever the user wrote around it. */
export function mergeIndex(existing: string | null, body: string, course: string): string {
  const block = `${START}\n${body}\n${END}`;
  if (existing === null) return `---\ncurator: index\ncours: "${course.replace(/"/g, "'")}"\n---\n${block}\n`;
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s >= 0 && e > s) return existing.slice(0, s) + block + existing.slice(e + END.length);
  return `${existing.trimEnd()}\n\n${block}\n`;
}
