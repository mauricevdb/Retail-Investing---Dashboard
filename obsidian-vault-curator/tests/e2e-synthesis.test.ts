// Real run of the synthesis pipeline with Claude Code. Opt-in:
//   CURATOR_E2E_SYN=/path/to/vault-copy CURATOR_SPACE="Machine Learning I" CURATOR_LOT="Machine Learning I/Semaine 2" \
//     npx vitest run tests/e2e-synthesis.test.ts
// Prints each stage: transcriptions, plan, written notes, coverage, archive. Every stage is accepted as is.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { Engine, PluginData } from "../src/engine";
import { Synthesizer } from "../src/learn/synthesizer";
import { ClaudeCodeBackend } from "../src/llm/claudeCode";
import { NodeIO } from "./nodeIO";

const vault = process.env.CURATOR_E2E_SYN;
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);
const out = (s: string) => fs.appendFileSync(`${vault}/../synthesis-report.md`, `${s}\n`);

describe.skipIf(!vault)("e2e: synthesis of a session", () => {
  it(
    "reads everything, plans notes, writes them, checks coverage and archives",
    async () => {
      fs.writeFileSync(`${vault}/../synthesis-report.md`, "");
      const io = new NodeIO(vault!);
      const data: PluginData = { settings: { ...DEFAULT_SETTINGS, spaces: [], concurrency: 4 }, ledger: {}, journal: [] };
      const backend = new ClaudeCodeBackend(vault!, () => data.settings);
      const engine = new Engine(io, () => backend, { data, save: async () => undefined }, "Vault");
      const syn = new Synthesizer(engine);
      const log = (m: string, d?: number, t?: number) => console.log(`  … ${m}${t ? ` ${d}/${t}` : ""}`);
      const spaceFolder = process.env.CURATOR_SPACE ?? "Machine Learning I";
      expect(await engine.addSpace(spaceFolder, "Cours de Machine Learning I du master.", "learning")).toBeNull();
      // A week folder managed on its own by version 0.3, as in a real upgraded vault.
      if (process.env.CURATOR_NESTED) expect(await engine.addSpace(process.env.CURATOR_NESTED, "", "learning")).toBeNull();
      const lot = await syn.lotFromFolder(engine.space(spaceFolder)!, process.env.CURATOR_LOT ?? `${spaceFolder}/Semaine 2`);
      let t = Date.now();
      let job = await syn.plan(lot, log);
      out(`# Lot : ${lot.name} (${lot.files.length} documents) — extraction + plan en ${Math.round((Date.now() - t) / 1000)} s\n`);
      for (const s of job.sources) {
        const e = job.extracts.get(s.id)!;
        out(`## ${s.id} ${s.path}\n*${e.description}*\n\n${e.text}\n\nIncertain : ${e.uncertain.join(" ; ") || "—"}\n`);
      }
      out(`# Plan v${job.round} — ${job.plan.session}\n${job.plan.summary}\n`);
      for (const s of job.plan.sources) out(`- ${s.sourceId} (${s.role}) : ${s.contributes}`);
      out(`\nProblèmes : ${job.plan.issues.join(" ; ") || "—"}\nNon affectées : ${job.unassigned.join(", ") || "—"}`);
      out(`\nModule : ${job.plan.module.mode} ${job.plan.module.id} « ${job.plan.module.title} » → ${job.plan.module.folder}`);
      for (const f of job.plan.fiches) out(`\n### ${f.id} — ${f.title} (${f.action}) → ${f.path}\nObjectif : ${f.objective}\nPrérequis : ${f.dependsOn.join(", ")}\nPlan : ${f.outline.join(" | ")}\nSources : ${f.sources.map((x) => `${x.sourceId}: ${x.what}`).join(" ; ")}`);
      out(`\nQuestions :\n${job.plan.questions.map((q) => `- ${q}`).join("\n")}\n`);
      expect(job.plan.fiches.length).toBeGreaterThan(0);

      t = Date.now();
      job = await syn.write(job, log);
      out(`# Rédaction + contrôle en ${Math.round((Date.now() - t) / 1000)} s\n## Couverture`);
      for (const c of job.coverage) out(`- ${c.covered ? "✓" : "✗"} ${c.sourceId} ${c.path}${c.missing.length ? ` — manque : ${c.missing.map((m) => m.item).join(" ; ")}` : ""}`);
      const report = await syn.apply(job, log);
      out(`\n# Application\nFiches : ${report.fiches.join(" ; ")}\nArchivés : ${report.archived.length}, gardés : ${report.kept.join(" ; ") || "—"}\nDocument d'archive : ${report.archiveDoc}\n`);
      out(`Dossiers gérés après : ${data.settings.spaces.map((x) => x.folder).join(" ; ")}`);
      for (const p of report.fiches) out(`\n========== ${p}\n${fs.readFileSync(`${vault}/${p}`, "utf8")}`);
    },
    90 * 60 * 1000,
  );
});
