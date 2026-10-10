// End-to-end run against the real Claude Code CLI on a copy of a vault. Opt-in:
//   CURATOR_E2E=/path/to/vault npx vitest run tests/e2e.test.ts
// Folders listed in CURATOR_SPACES (comma-separated, default: every top-level folder but Templates)
// are organised; the first one goes through a revision round with scripted feedback. Every
// proposed op is then accepted, as if the user clicked "Valider et appliquer".
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { SpaceMap } from "../src/core/types";
import { Engine, PluginData, PreparedPlan } from "../src/engine";
import { ClaudeCodeBackend } from "../src/llm/claudeCode";
import { NodeIO } from "./nodeIO";

const vault = process.env.CURATOR_E2E;
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);

function show(p: PreparedPlan) {
  const u = p.plan.understanding;
  const lines = [`\n===== ${p.mode} v${p.round} — ${p.space.name}`];
  if (p.mode === "initial") lines.push(`[${u.kind}] but : ${u.purpose}`, `usage : ${u.usage}`, `principe : ${u.principle}`);
  lines.push(p.plan.summary);
  for (const c of p.plan.changes) lines.push(`  Δ ${c}`);
  for (const q of p.plan.questions) lines.push(`  ? ${q}`);
  for (const d of p.plan.dashboards) lines.push(`  [dashboard] ${d.path} → ${d.decision} (${d.rationale})`);
  for (const op of p.checked) lines.push(`  ${op.error ? "✗" : "✓"} ${op.kind} ${op.source ?? ""} → ${op.target ?? ""}${op.error ? `  [${op.error}]` : ""}  — ${op.reason}`);
  if (p.mode === "initial") {
    const m = p.plan.map;
    lines.push(`  dashboard « ${m.dashboardTitle} » (${m.linkKind}) : ${m.sections.map((s) => `${s.title}${s.dependsOn.length ? ` ←${s.dependsOn.join(",")}` : ""}`).join(" | ")}`);
    lines.push(`  règles : ${m.conventions.replace(/\n/g, " / ")}`);
    if (m.preferences.length) lines.push(`  préférences : ${m.preferences.join(" / ")}`);
  }
  console.log(lines.join("\n"));
}

describe.skipIf(!vault)("e2e with Claude Code", () => {
  it(
    "organises several kinds of folders, revises with feedback, then aggregates new material",
    async () => {
      const io = new NodeIO(vault!);
      const data: PluginData = { settings: { ...DEFAULT_SETTINGS, spaces: [], concurrency: 3 }, ledger: {}, journal: [] };
      const backend = new ClaudeCodeBackend(vault!, () => data.settings);
      expect(await backend.check()).toBeNull();
      const engine = new Engine(io, () => backend, { data, save: async () => fs.writeFileSync(`${vault}/.curator-data.json`, JSON.stringify(data, null, 2)) }, "Vault");
      const log = (m: string, d?: number, t?: number) => console.log(`  … ${m}${t ? ` ${d}/${t}` : ""}`);

      const folders = (process.env.CURATOR_SPACES ?? "").split(",").filter(Boolean);
      const chosen = folders.length ? folders : io.listFolders().filter((f) => !f.includes("/") && f !== "Templates");
      for (const f of chosen) expect(await engine.addSpace(f)).toBeNull();

      for (const [i, folder] of chosen.entries()) {
        const space = engine.space(folder)!;
        let prepared = await engine.planInitial(space, log);
        show(prepared);
        if (i === 0) {
          prepared = await engine.revise(
            prepared,
            {
              answers: prepared.plan.questions.slice(0, 1).map((question) => ({ question, answer: "Fais au plus simple, je préfère moins de dossiers." })),
              opComments: [],
              refused: [],
              edited: [],
              general: "Je retrouve mes papiers par domaine puis par année. Garde aussi une note de suivi des démarches en cours.",
            },
            log,
          );
          show(prepared);
          expect(prepared.round).toBe(2);
          expect(prepared.plan.changes.length).toBeGreaterThan(0);
        }
        const report = await engine.apply(prepared, prepared.checked.map(() => true), log);
        console.log(`  applied ${report.applied}, failed ${JSON.stringify(report.failed.map((f) => f.error))}, dropped ${JSON.stringify(report.dropped)}`);
        const index = fs.readFileSync(`${vault}/${space.generated.index}`, "utf8");
        console.log(`  à classer : ${index.includes("## 📥 À classer") ? index.split("## 📥 À classer")[1].split("<small>")[0].trim() : "rien"}`);
      }

      // New material: a document in the inbox and one dropped in each managed folder by the test.
      fs.mkdirSync(`${vault}/📥 Inbox`, { recursive: true });
      fs.copyFileSync(`${__dirname}/fixtures/var.pdf`, `${vault}/📥 Inbox/Document.pdf`);
      for (const f of chosen) fs.writeFileSync(`${vault}/${f}/nouveau ${Date.now() % 1000}.md`, fs.readFileSync(`${__dirname}/fixtures/new-${f.normalize("NFD").replace(/[̀-ͯ]/g, "").split(" ")[0].toLowerCase()}.md`, "utf8"));
      const scan = engine.scan();
      const { routed, unrouted } = await engine.routeInbox(scan, log);
      console.log(`routed: ${JSON.stringify([...routed].map(([k, v]) => [k, v.map((f) => f.path)]))}, unrouted ${unrouted.length}`);
      for (const space of scan.spaces) {
        const files = [...engine.newFiles(space), ...(routed.get(space.folder) ?? [])];
        if (!files.length) continue;
        const prepared = await engine.planIncremental(space, files, log);
        show(prepared);
        const report = await engine.apply(prepared, prepared.checked.map(() => true), log);
        console.log(`  applied ${report.applied}, failed ${JSON.stringify(report.failed.map((f) => f.error))}, dropped ${JSON.stringify(report.dropped)}`);
        const map = JSON.parse(fs.readFileSync(`${vault}/${space.generated.map}`, "utf8")) as SpaceMap;
        console.log(`  préférences retenues : ${map.preferences.join(" / ") || "—"}`);
      }
      expect(engine.scan().inbox.length).toBe(0);
    },
    60 * 60 * 1000,
  );
});
