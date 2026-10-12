// Real run of the synthesis pipeline on a whole folder of courses, on a copy of the vault. Opt-in:
//   CURATOR_E2E_PROGRAMME=/path/to/vault-copy CURATOR_ROOT=DDDF [CURATOR_DATA=/path/data.json] [CURATOR_COURSES="Machine Learning I,…"] \
//     npx vitest run tests/e2e-programme.test.ts
// Every plan and every note is accepted as is. One report per course next to the vault: reports/<course>.md.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { Engine, PluginData } from "../src/engine";
import { Synthesizer } from "../src/learn/synthesizer";
import { ClaudeCodeBackend } from "../src/llm/claudeCode";
import { NodeIO } from "./nodeIO";

const vault = process.env.CURATOR_E2E_PROGRAMME;
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);

describe.skipIf(!vault)("e2e: synthesis of a whole folder of courses", () => {
  it(
    "synthesises every course, session by session",
    async () => {
      const root = process.env.CURATOR_ROOT ?? "DDDF";
      const reports = `${vault}/../reports`;
      fs.mkdirSync(reports, { recursive: true });
      const io = new NodeIO(vault!);
      const data: PluginData = { settings: { ...DEFAULT_SETTINGS, spaces: [], concurrency: 4 }, ledger: {}, journal: [] };
      const backend = new ClaudeCodeBackend(vault!, () => data.settings);
      const engine = new Engine(io, () => backend, { data, save: async () => undefined }, "Vault");
      const syn = new Synthesizer(engine);

      // The user's managed folders and instructions, as in the real vault.
      const saved = process.env.CURATOR_DATA ? (JSON.parse(fs.readFileSync(process.env.CURATOR_DATA, "utf8").replace(/^﻿/, "")) as PluginData) : null;
      const spaces = saved?.settings.spaces ?? [{ folder: root, instructions: "Dossier contenant mes cours de master. Un sous-dossier par cours.", mode: "learning" as const }];
      for (const s of spaces) if (io.exists(s.folder)) expect(await engine.addSpace(s.folder, s.instructions, "learning")).toBeNull();
      const programme = data.settings.spaces.find((s) => s.folder === root)!;
      programme.level = "programme";

      const only = process.env.CURATOR_COURSES?.split(",").map((c) => c.trim());
      const courses = syn.coursesOf(root).filter((c) => !only || only.some((o) => c.endsWith(`/${o}`)));
      const summary: string[] = [`# Essai sur ${root} — ${new Date().toISOString()}\n`];
      for (const folder of courses) {
        const name = folder.split("/").pop()!;
        const file = `${reports}/${name}.md`;
        const out = (s: string) => fs.appendFileSync(file, `${s}\n`);
        fs.writeFileSync(file, `# ${name}\n\n`);
        const course = (await syn.courseFor(folder))!;
        const lots = await syn.courseLots(course);
        summary.push(`## ${name} — ${lots.length} lot(s)`);
        for (const lot of lots) {
          const log = (m: string, d?: number, t?: number) => console.log(`  [${name} / ${lot.name}] ${m}${t ? ` ${d}/${t}` : ""}`);
          const t0 = Date.now();
          try {
            let job = await syn.plan(lot, log);
            out(`\n---\n# Lot : ${lot.name} (${job.sources.length} sources)\n`);
            for (const s of job.sources) {
              const e = job.extracts.get(s.id);
              out(`- ${s.id} ${s.path}${s.embeddedIn ? ` (insérée dans ${s.embeddedIn})` : ""} — ${syn.disposition(job, s.id)} — ${e?.description ?? "non lu"}`);
            }
            out(`\n## Plan — ${job.plan.session} (langue : ${job.plan.language})\n${job.plan.summary}\n`);
            out(`Problèmes : ${job.plan.issues.join(" ; ") || "—"}\nNon affectées : ${job.unassigned.join(", ") || "—"}`);
            out(`Module : ${job.plan.module.mode} ${job.plan.module.id} « ${job.plan.module.title} » → ${job.plan.module.folder}`);
            out(`Ordre des modules : ${job.plan.tree.moduleOrder.join(" → ")}`);
            for (const u of job.plan.tree.updates) out(`- remodelage ${u.id} : prérequis ${u.dependsOn.join(", ") || "aucun"} — ${u.why}`);
            for (const f of job.plan.fiches) out(`\n### ${f.title} (${f.action}) → ${f.path}\nPrérequis : ${f.dependsOn.join(", ") || "—"}\nPlan : ${f.outline.join(" | ")}`);
            out(`\nQuestions :\n${job.plan.questions.map((q) => `- ${q}`).join("\n") || "—"}`);
            job = await syn.write(job, log);
            out(`\n## Couverture`);
            for (const c of job.coverage) out(`- ${c.kept ? "↷" : c.covered ? "✓" : "✗"} ${c.path}${c.missing.length ? ` — manque : ${c.missing.map((m) => m.item).join(" ; ")}` : ""}`);
            const report = await syn.apply(job, log);
            const s = Math.round((Date.now() - t0) / 1000);
            out(`\n## Appliqué en ${s} s : ${report.fiches.length} fiche(s), ${report.archived.length + report.kept.length} source(s) rangée(s), ${report.pending.length} non intégrée(s)`);
            summary.push(`- ${lot.name} : ${report.fiches.length} fiche(s), ${report.pending.length} non intégrée(s), ${s} s`);
          } catch (err) {
            out(`\n## ERREUR sur ${lot.name}\n${(err as Error).stack}`);
            summary.push(`- ${lot.name} : ERREUR ${(err as Error).message}`);
          }
          fs.writeFileSync(`${reports}/_resume.md`, summary.join("\n"));
        }
      }
    },
    12 * 60 * 60 * 1000,
  );
});
