import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseCanvas } from "../src/core/canvas";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { SpaceMap } from "../src/core/types";
import { Engine, PluginData } from "../src/engine";
import { Synthesizer } from "../src/learn/synthesizer";
import { SynthesisPlan } from "../src/learn/types";
import { LlmBackend, LlmRequest } from "../src/llm/types";
import { NodeIO } from "./nodeIO";

class FakeLlm implements LlmBackend {
  readonly name = "fake";
  calls: LlmRequest[] = [];
  constructor(private readonly answers: (req: LlmRequest) => unknown) {}
  async check() {
    return null;
  }
  async complete<T>(req: LlmRequest): Promise<T> {
    this.calls.push(req);
    return structuredClone(this.answers(req)) as T;
  }
}

let root: string;
let io: NodeIO;
let data: PluginData;
const write = (p: string, content: string | Buffer = "x") => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), content);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "curator-syn-"));
  io = new NodeIO(root);
  data = { settings: { ...DEFAULT_SETTINGS, spaces: [], concurrency: 2 }, ledger: {}, journal: [] };
  write("ML/01 Régression/Fiche régression.md", "---\ncurator: fiche\n---\n# Régression\n## Biais et variance\nErreur = biais² + variance.");
  write("ML/Semaine 2/IMG_1.jpg", fs.readFileSync(path.join(__dirname, "fixtures/board.jpg")));
  write("ML/Semaine 2/notes.md", "# notes\nknn = voisins\nquestion : pourquoi k impair ?");
  write("ML/Semaine 2/slides.docx", "binaire");
});

const plan: SynthesisPlan = {
  session: "Semaine 2 — k-NN",
  summary: "Séance sur les k plus proches voisins.",
  sources: [
    { sourceId: "S1", role: "tableau", contributes: "règle de décision" },
    { sourceId: "S2", role: "notes", contributes: "question k impair" },
  ],
  issues: [],
  module: { id: "knn", title: "k plus proches voisins", mode: "new", folder: "02 k-NN", dependsOn: [], summary: "Méthode des voisins." },
  fiches: [
    {
      id: "knn-principe",
      title: "Principe du k-NN",
      path: "02 k-NN/1 - Principe du k-NN",
      action: "create",
      objective: "Appliquer la règle de décision.",
      outline: ["Intuition", "Formules", "À retenir"],
      sources: [
        { sourceId: "S1", what: "règle" },
        { sourceId: "S2", what: "question" },
      ],
      dependsOn: ["regression"],
      keywords: ["vote majoritaire"],
    },
  ],
  questions: ["Un module par semaine ?"],
  changes: [],
  preferences: [],
};

function setup(coverageMissing = true) {
  let coverageRound = 0;
  const llm = new FakeLlm((req) => {
    if (req.label.startsWith("transcription")) return { description: "tableau", transcript: "Durbin-Watson brouillon", uncertain: [] };
    if (req.label.startsWith("vérification")) return { transcript: "Autocorrélation des résidus : $DW \\approx 2(1-\\rho)$", corrections: ["DW"], uncertain: ["indice ?"] };
    if (req.label.startsWith("plan de synthèse")) return plan;
    if (req.label.startsWith("révision du plan")) return { ...plan, changes: ["Un seul module."], questions: [] };
    if (req.label.startsWith("rédaction")) return { content: "# Principe du k-NN\nVote majoritaire.", summary: "" };
    if (req.label.startsWith("contrôle")) {
      coverageRound++;
      if (coverageMissing && coverageRound === 1) {
        return {
          sources: [
            { sourceId: "S1", covered: false, missing: [{ item: "formule DW", fiche: "ML/02 k-NN/1 - Principe du k-NN.md" }] },
            { sourceId: "S2", covered: true, missing: [] },
          ],
        };
      }
      return { sources: [{ sourceId: "S1", covered: true, missing: [] }, { sourceId: "S2", covered: true, missing: [] }] };
    }
    if (req.label.startsWith("complément")) return { content: "# Principe du k-NN\nVote majoritaire.\n$DW \\approx 2(1-\\rho)$", summary: "DW ajouté" };
    throw new Error(`unexpected ${req.label}`);
  });
  const engine = new Engine(io, () => llm, { data, save: async () => undefined }, "Vault");
  return { llm, engine, syn: new Synthesizer(engine) };
}

describe("Synthesizer", () => {
  it("reads everything, plans, writes, checks coverage, archives and updates the skill tree", async () => {
    const { llm, engine, syn } = setup();
    await engine.addSpace("ML", "", "learning");
    const lot = await syn.lotFromFolder(engine.space("ML")!, "ML/Semaine 2");
    expect(lot.files.map((f) => f.path).sort()).toEqual(["ML/Semaine 2/IMG_1.jpg", "ML/Semaine 2/notes.md", "ML/Semaine 2/slides.docx"]);

    let job = await syn.plan(lot, () => undefined);
    // Photo: zoomed views, a draft then a verification on the same views.
    const transcription = llm.calls.find((c) => c.label.startsWith("transcription"))!;
    expect(transcription.model).toBe("claude-opus-5-5");
    expect(transcription.attachments!.length).toBeGreaterThanOrEqual(1);
    const photo = job.sources.find((s) => s.kind === "image")!;
    expect(job.extracts.get(photo.id)!.text).toContain("2(1-\\rho)");
    // The plan prompt carries the full content and the course's existing notes.
    const planCall = llm.calls.find((c) => c.label.startsWith("plan de synthèse"))!;
    expect(planCall.prompt).toContain("question : pourquoi k impair ?");
    expect(planCall.prompt).toContain("ML/01 Régression/Fiche régression.md");
    // Paths are made safe; the .docx no note uses is reported.
    expect(job.plan.fiches[0].path).toBe("ML/02 k-NN/1 - Principe du k-NN.md");
    expect(job.plan.module.folder).toBe("ML/02 k-NN");
    expect(job.unassigned).toEqual([job.sources.find((s) => s.path.endsWith(".docx"))!.id]);

    // Extractions are cached: a revision does not read the photo again.
    const before = llm.calls.length;
    job = await syn.revise(job, { answers: [{ question: "Un module par semaine ?", answer: "Non, par notion" }], ficheComments: [], general: "", transcriptions: [] }, () => undefined);
    expect(llm.calls.slice(before).map((c) => c.label)).toEqual(["révision du plan de synthèse pour Semaine 2"]);
    expect(llm.calls.at(-1)!.prompt).toContain("→ réponse : Non, par notion");
    expect(job.round).toBe(2);

    job = await syn.write(job, () => undefined);
    // The missing element was added, then coverage passed.
    expect(job.written[0].content).toContain("$DW \\approx 2(1-\\rho)$");
    expect(job.written[0].content).toMatch(/^---\ncurator: fiche/);
    const byPath = new Map(job.coverage.map((c) => [c.path, c.covered]));
    expect(byPath.get("ML/Semaine 2/IMG_1.jpg")).toBe(true);
    expect(byPath.get("ML/Semaine 2/slides.docx")).toBe(false);

    const report = await syn.apply(job, () => undefined);
    expect(report.fiches).toEqual(["ML/02 k-NN/1 - Principe du k-NN.md"]);
    expect(report.archived.sort()).toEqual(["ML/Semaine 2/IMG_1.jpg", "ML/Semaine 2/notes.md"]);
    expect(report.kept).toEqual(["ML/Semaine 2/slides.docx"]);
    expect(io.exists("Archive/ML/02 k-NN/IMG_1.jpg")).toBe(true);
    const archive = await io.read(report.archiveDoc);
    expect(archive).toContain("![[Archive/ML/02 k-NN/IMG_1.jpg]]");
    expect(archive).toContain("$DW \\approx 2(1-\\rho)$");
    expect(archive).toContain("Non archivé");

    const map = JSON.parse(await io.read("ML/_curator.json")) as SpaceMap;
    const module = map.sections.find((s) => s.id === "knn")!;
    expect(module.children.map((c) => c.id)).toEqual(["knn-principe"]);
    expect(module.children[0].resources[0]).toMatchObject({ path: "ML/02 k-NN/1 - Principe du k-NN.md", role: "fiche" });
    expect(module.resources.some((r) => r.role === "archive")).toBe(true);
    expect(parseCanvas(await io.read(engine.space("ML")!.generated.canvas))!.nodes.some((n) => n.id === "cc-m-knn-principe")).toBe(true);

    // The new note is known; untouched raw material elsewhere in the course is still new.
    const fresh = engine.newFiles(engine.space("ML")!).map((f) => f.path);
    expect(fresh).not.toContain("ML/02 k-NN/1 - Principe du k-NN.md");
    expect(fresh).toContain("ML/01 Régression/Fiche régression.md");

    // Undo puts everything back.
    await engine.undoLast();
    expect(io.exists("ML/Semaine 2/IMG_1.jpg")).toBe(true);
    expect(io.exists("ML/02 k-NN/1 - Principe du k-NN.md")).toBe(false);
  });

  it("keeps corrected transcriptions and never re-reads them", async () => {
    const { llm, engine, syn } = setup(false);
    await engine.addSpace("ML", "", "learning");
    const lot = await syn.lotFromFolder(engine.space("ML")!, "ML/Semaine 2");
    const job = await syn.plan(lot, () => undefined);
    const photo = job.sources.find((s) => s.kind === "image")!;
    await syn.correct(job, photo.id, "Transcription corrigée à la main");
    const again = await syn.plan(await syn.lotFromFolder(engine.space("ML")!, "ML/Semaine 2"), () => undefined);
    expect(again.extracts.get(photo.id)).toMatchObject({ text: "Transcription corrigée à la main", editedByUser: true });
    expect(llm.calls.filter((c) => c.label.startsWith("transcription"))).toHaveLength(1);
    expect(llm.calls.at(-1)!.prompt).toContain("relue et corrigée par l'utilisateur");
  });

  it("does not take study notes already written as sources", async () => {
    const { engine, syn } = setup(false);
    await engine.addSpace("ML", "", "learning");
    const lot = await syn.lotFromFolder(engine.space("ML")!, "ML/01 Régression");
    expect(lot.files).toEqual([]);
  });

  it("takes the files of a week folder managed on its own by an older version", async () => {
    const { engine, syn } = setup(false);
    await engine.addSpace("ML", "", "learning");
    await engine.addSpace("ML/Semaine 2", "", "learning");
    expect(engine.space("ML")!.files.some((f) => f.path.startsWith("ML/Semaine 2/"))).toBe(false);
    const lot = await syn.lotFromFolder(engine.space("ML")!, "ML/Semaine 2");
    expect(lot.files.map((f) => f.path).sort()).toEqual(["ML/Semaine 2/IMG_1.jpg", "ML/Semaine 2/notes.md", "ML/Semaine 2/slides.docx"]);
  });
});
