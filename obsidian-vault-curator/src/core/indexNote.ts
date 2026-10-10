import { resourceLines } from "./canvas";
import { stem } from "./paths";
import { SectionNode, SpaceMap } from "./types";

export const START = "<!-- course-curator:start -->";
export const END = "<!-- course-curator:end -->";

function sectionBlock(m: SectionNode, number: string, depth: number): string {
  const status = m.status === "done" ? " ✅" : m.status === "doing" ? " 🟨" : "";
  const parts = [`${"#".repeat(depth)} ${number} · ${m.title}${status}`];
  if (m.summary) parts.push(m.summary);
  if (m.keywords.length) parts.push(`**Mots-clés** : ${m.keywords.join(" · ")}`);
  const lines = resourceLines(m.resources);
  if (lines.length) parts.push(lines.join("\n"));
  m.children.forEach((c, i) => parts.push(sectionBlock(c, `${number}.${i + 1}`, depth + 1)));
  return parts.join("\n\n");
}

/** Markdown twin of the canvas, plus the folder's "user manual": readable on mobile, searchable. */
export function renderIndexBody(map: SpaceMap, canvasPath: string, unfiled: string[], subspaces: { name: string; canvas: string }[] = []): string {
  const parts = [`# ${map.name}`];
  if (map.summary) parts.push(map.summary);
  parts.push(`> [!tip] Dashboard visuel : [[${canvasPath}|${stem(canvasPath)}]]`);

  const manual: string[] = [];
  if (map.purpose) manual.push(`**À quoi sert ce dossier** — ${map.purpose}`);
  if (map.usage) manual.push(`**Comment s'en servir** — ${map.usage}`);
  if (map.conventions) manual.push(`**Règles de rangement**\n\n${map.conventions}`);
  if (map.preferences.length) manual.push(`**Tes préférences retenues**\n\n${map.preferences.map((p) => `- ${p}`).join("\n")}`);
  if (manual.length) parts.push(`> [!info]- Mode d'emploi\n${manual.join("\n\n").replace(/^/gm, "> ")}`);

  if (map.keptDashboards.length) parts.push(`Anciens dashboards conservés : ${map.keptDashboards.map((d) => `[[${d}|${stem(d)}]]`).join(" · ")}`);
  if (subspaces.length) parts.push(`## 🗂️ Sous-dossiers organisés\n\n${subspaces.map((s) => `- [[${s.canvas}|${s.name}]]`).join("\n")}`);
  if (map.transverse.length) parts.push(`## 📚 Ressources transverses\n\n${resourceLines(map.transverse).join("\n")}`);
  map.sections.forEach((m, i) => parts.push(sectionBlock(m, String(i + 1).padStart(2, "0"), 2)));
  if (unfiled.length) parts.push(`## 📥 À classer\n\n${unfiled.map((p) => `- [[${p}|${stem(p)}]]`).join("\n")}`);
  parts.push(`<small>Généré par Vault Curator le ${map.updatedAt.slice(0, 10)}. Le texte écrit hors des balises est conservé.</small>`);
  return parts.join("\n\n");
}

/** Replaces the generated block, keeping whatever the user wrote around it. */
export function mergeIndex(existing: string | null, body: string, name: string): string {
  const block = `${START}\n${body}\n${END}`;
  if (existing === null) return `---\ncurator: index\ndossier: "${name.replace(/"/g, "'")}"\n---\n${block}\n`;
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s >= 0 && e > s) return existing.slice(0, s) + block + existing.slice(e + END.length);
  return `${existing.trimEnd()}\n\n${block}\n`;
}
