// End-to-end run against the real Claude Code CLI on a copy of a vault. Opt-in:
//   CURATOR_E2E=/path/to/vault npx vitest run tests/e2e.test.ts
// Every proposed op is accepted (as if the user clicked "Appliquer"); the report is printed.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { CourseMap } from "../src/core/types";
import { Engine, PluginData, PreparedPlan } from "../src/engine";
import { ClaudeCodeBackend } from "../src/llm/claudeCode";
import { NodeIO } from "./nodeIO";

const vault = process.env.CURATOR_E2E;
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);

function show(p: PreparedPlan) {
  const lines = [`\n===== ${p.mode} — ${p.course.name}`, p.plan.summary];
  for (const q of p.plan.questions) lines.push(`  ? ${q}`);
  for (const d of p.plan.dashboards) lines.push(`  [dashboard] ${d.path} → ${d.decision} (${d.rationale})`);
  for (const op of p.checked) lines.push(`  ${op.error ? "✗" : "✓"} ${op.kind} ${op.source ?? ""} → ${op.target ?? ""}${op.error ? `  [${op.error}]` : ""}  — ${op.reason}`);
  console.log(lines.join("\n"));
}

describe.skipIf(!vault)("e2e with Claude Code", () => {
  it(
    "organises the vault, then aggregates new documents",
    async () => {
      const io = new NodeIO(vault!);
      const data: PluginData = { settings: { ...DEFAULT_SETTINGS, concurrency: 3 }, ledger: {}, journal: [] };
      const backend = new ClaudeCodeBackend(vault!, () => data.settings);
      expect(await backend.check()).toBeNull();
      const engine = new Engine(io, () => backend, { data, save: async () => fs.writeFileSync(`${vault}/.curator-data.json`, JSON.stringify(data, null, 2)) });
      const log = (m: string, d?: number, t?: number) => console.log(`  … ${m}${t ? ` ${d}/${t}` : ""}`);

      for (const course of engine.scan().courses) {
        const prepared = await engine.planOnboarding(course, log);
        show(prepared);
        const report = await engine.apply(prepared, prepared.checked.map(() => true), log);
        console.log(`  applied ${report.applied}, failed ${JSON.stringify(report.failed.map((f) => f.error))}, dropped ${JSON.stringify(report.dropped)}`);
        const map = JSON.parse(fs.readFileSync(`${vault}/${course.generated.map}`, "utf8")) as CourseMap;
        const index = fs.readFileSync(`${vault}/${course.generated.index}`, "utf8");
        console.log(`  à classer : ${index.includes("## 📥 À classer") ? index.split("## 📥 À classer")[1].split("<small>")[0].trim() : "rien"}`);
        console.log(map.modules.map((m) => `  # ${m.id} ${m.title} [${m.prerequisites.join(",")}] ${m.resources.length} docs`).join("\n"));
      }

      // New material arrives: a document in the inbox and a photo dropped in a course.
      fs.mkdirSync(`${vault}/📥 Inbox`, { recursive: true });
      fs.copyFileSync(`${__dirname}/fixtures/var.pdf`, `${vault}/📥 Inbox/Document.pdf`);
      fs.copyFileSync(`${__dirname}/fixtures/board.jpg`, `${vault}/Économétrie/IMG_7001.jpg`);
      const scan = engine.scan();
      const { routed, unrouted } = await engine.routeInbox(scan, log);
      console.log(`routed: ${JSON.stringify([...routed].map(([k, v]) => [k, v.map((f) => f.path)]))}, unrouted ${unrouted.length}`);
      for (const course of scan.courses) {
        const files = [...engine.newFiles(course), ...(routed.get(course.folder) ?? [])];
        if (!files.length) continue;
        const prepared = await engine.planIncremental(course, files, log);
        show(prepared);
        const report = await engine.apply(prepared, prepared.checked.map(() => true), log);
        console.log(`  applied ${report.applied}, failed ${JSON.stringify(report.failed.map((f) => f.error))}, dropped ${JSON.stringify(report.dropped)}`);
      }
      expect(engine.scan().inbox.length).toBe(0);
    },
    60 * 60 * 1000,
  );
});
