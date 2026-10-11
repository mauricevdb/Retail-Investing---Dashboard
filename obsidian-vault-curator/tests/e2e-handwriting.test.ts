// Real run of the handwriting integration with Claude Code. Opt-in:
//   CURATOR_E2E_HW=/path/to/vault-copy CURATOR_SPACES="Machine Learning I" npx vitest run tests/e2e-handwriting.test.ts
// Organises the folder, accepts every op and prints the notes that received handwritten content.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { Engine, PluginData } from "../src/engine";
import { ClaudeCodeBackend } from "../src/llm/claudeCode";
import { NodeIO } from "./nodeIO";

const vault = process.env.CURATOR_E2E_HW;
(globalThis as { require?: unknown }).require ??= createRequire(import.meta.url);

describe.skipIf(!vault)("e2e: handwriting merged into notes", () => {
  it(
    "integrates photos of the board and notebook into their notes",
    async () => {
      const io = new NodeIO(vault!);
      const data: PluginData = { settings: { ...DEFAULT_SETTINGS, spaces: [], concurrency: 3 }, ledger: {}, journal: [] };
      const backend = new ClaudeCodeBackend(vault!, () => data.settings);
      const engine = new Engine(io, () => backend, { data, save: async () => undefined }, "Vault");
      const log = (m: string, d?: number, t?: number) => console.log(`  … ${m}${t ? ` ${d}/${t}` : ""}`);
      const folder = process.env.CURATOR_SPACES ?? "Machine Learning I";
      expect(await engine.addSpace(folder)).toBeNull();
      const prepared = await engine.planInitial(engine.space(folder)!, log);
      console.log(prepared.plan.summary);
      for (const q of prepared.plan.questions) console.log(`  ? ${q}`);
      for (const op of prepared.checked) {
        const what = op.kind === "integrate" ? `${(op.sources ?? []).join(" + ")} ⇒ ${op.target}` : `${op.source ?? ""} → ${op.target ?? ""}`;
        console.log(`  ${op.error ? "✗" : op.warning ? "⚠" : "✓"} ${op.kind} ${what}${op.error ? `  [${op.error}]` : ""}${op.warning ? `  [${op.warning}]` : ""}  — ${op.reason}`);
      }
      const integrations = prepared.checked.filter((o) => o.kind === "integrate");
      expect(integrations.length).toBeGreaterThan(0);
      const report = await engine.apply(prepared, prepared.checked.map((c) => !c.error), log);
      console.log(`applied ${report.applied}, failed ${JSON.stringify(report.failed.map((f) => f.error))}`);
      for (const op of integrations.filter((o) => !o.error)) {
        console.log(`\n========== ${op.target} (${op.before === null || op.before === undefined ? "nouvelle" : "complétée"})\n${fs.readFileSync(`${vault}/${op.target}`, "utf8")}`);
      }
    },
    30 * 60 * 1000,
  );
});
