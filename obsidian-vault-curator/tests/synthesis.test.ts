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
import { dirname } from "../src/core/paths";

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
  language: "English",
  summary: "Séance sur les k plus proches voisins.",
  sources: [
    { sourceId: "S1", role: "tableau", contributes: "règle de décision", disposition: "integrate" },
    { sourceId: "S2", role: "notes", contributes: "question k impair", disposition: "integrate" },
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
  tree: { moduleOrder: [], updates: [] },
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
            { sourceId: "S1", covered: false, missing: [{ item: "formule DW", fiche: "ML/Semaine 2/Fiches/01 - Principe du k-NN.md" }] },
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
    // Paths are made safe; the .docx (not readable) is kept in place, never archived.
    // The session folder is kept; notes are numbered in its notes folder.
    expect(job.plan.fiches[0].path).toBe("ML/Semaine 2/Fiches/01 - Principe du k-NN.md");
    expect(job.plan.module.folder).toBe("ML/Semaine 2");
    expect(job.unassigned).toEqual([]);
    expect(syn.disposition(job, job.sources.find((s) => s.path.endsWith(".docx"))!.id)).toBe("keep");

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
    expect(job.coverage.find((c) => c.path.endsWith(".docx"))).toMatchObject({ kept: true });

    const report = await syn.apply(job, () => undefined);
    expect(report.fiches).toEqual(["ML/Semaine 2/Fiches/01 - Principe du k-NN.md"]);
    expect(report.archived.sort()).toEqual(["ML/Semaine 2/IMG_1.jpg", "ML/Semaine 2/notes.md"]);
    expect(report.kept).toEqual(["ML/Semaine 2/slides.docx"]);
    expect(report.pending).toEqual([]);
    // Inputs in the session's sources folder, the unreadable .docx with them.
    expect(io.exists("ML/Semaine 2/Sources/IMG_1.jpg")).toBe(true);
    expect(io.exists("ML/Semaine 2/Sources/slides.docx")).toBe(true);
    expect(report.archiveDoc).toBe("ML/Semaine 2/Sources/Transcriptions — Semaine 2 — k-NN.md");
    const archive = await io.read(report.archiveDoc);
    expect(archive).toContain("![[ML/Semaine 2/Sources/IMG_1.jpg]]");
    expect(archive).toContain("$DW \\approx 2(1-\\rho)$");
    expect(archive).toContain("Non transcrit (keep)");

    const map = JSON.parse(await io.read("ML/_curator.json")) as SpaceMap;
    const module = map.sections.find((s) => s.id === "knn")!;
    expect(module.children.map((c) => c.id)).toEqual(["knn-principe"]);
    expect(module.children[0].resources[0]).toMatchObject({ path: "ML/Semaine 2/Fiches/01 - Principe du k-NN.md", role: "fiche" });
    expect(module.resources.some((r) => r.role === "archive")).toBe(true);
    // One skill tree, the course's: the note's card links to the note in its session folder.
    expect(report.canvas).toBe("ML/00 Skill tree — ML.canvas");
    const tree = parseCanvas(await io.read(report.canvas))!;
    expect(tree.nodes.find((n) => n.id === "cc-m-knn-principe")!.text).toContain("[[ML/Semaine 2/Fiches/01 - Principe du k-NN.md|");
    expect(io.listFiles().filter((f) => f.path.endsWith(".canvas")).map((f) => f.path)).toEqual(["ML/00 Skill tree — ML.canvas"]);

    // The new note is known; untouched raw material elsewhere in the course is still new.
    const fresh = engine.newFiles(engine.space("ML")!).map((f) => f.path);
    expect(fresh).not.toContain("ML/Semaine 2/Fiches/01 - Principe du k-NN.md");
    expect(fresh).toContain("ML/01 Régression/Fiche régression.md");

    // Undo puts everything back.
    await engine.undoLast();
    expect(io.exists("ML/Semaine 2/IMG_1.jpg")).toBe(true);
    expect(io.exists("ML/Semaine 2/Fiches/01 - Principe du k-NN.md")).toBe(false);
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

describe("Session layout", () => {
  it("reshapes the course skill tree around a new session", async () => {
    const reshaped: SynthesisPlan = {
      ...plan,
      tree: { moduleOrder: ["knn", "regression"], updates: [{ id: "biais-variance", dependsOn: ["knn-principe"], summary: "Vu avec le k-NN.", why: "Le compromis est introduit sur k." }] },
    };
    const llm = new FakeLlm((req) => {
      if (req.label.startsWith("transcription")) return { description: "", transcript: "t", uncertain: [] };
      if (req.label.startsWith("vérification")) return { transcript: "t", corrections: [], uncertain: [] };
      if (req.label.startsWith("plan de synthèse")) return reshaped;
      if (req.label.startsWith("rédaction")) return { content: "# k-NN", summary: "" };
      if (req.label.startsWith("contrôle")) return { sources: [] };
      throw new Error(req.label);
    });
    const engine = new Engine(io, () => llm, { data, save: async () => undefined }, "Vault");
    const syn = new Synthesizer(engine);
    await engine.addSpace("ML", "", "learning");
    const fiche = "ML/01 Régression/Fiche régression.md";
    const existing: SpaceMap = {
      version: 2, name: "ML", folder: "ML", kind: "cours", summary: "", purpose: "", usage: "", conventions: "", preferences: [],
      dashboardTitle: "Skill tree", linkKind: "prerequisite", transverse: [], keptDashboards: [], updatedAt: "",
      sections: [{ id: "regression", title: "Régression", summary: "", keywords: [], dependsOn: [], folder: "ML/01 Régression", resources: [], children: [
        { id: "biais-variance", title: "Biais et variance", summary: "Ancien résumé", keywords: [], dependsOn: [], folder: null, resources: [{ path: fiche, role: "fiche", label: "Biais et variance" }], children: [] },
      ] }],
    };
    write("ML/_curator.json", JSON.stringify(existing));
    let job = await syn.plan(await syn.lotFromFolder(engine.space("ML")!, "ML/Semaine 2"), () => undefined);
    // The plan sees the whole course tree, with ids, to re-link it.
    expect(llm.calls.find((c) => c.label.startsWith("plan de synthèse"))!.prompt).toContain("fiche biais-variance « Biais et variance »");
    job = await syn.write(job, () => undefined);
    await syn.apply(job, () => undefined);
    const map = JSON.parse(await io.read("ML/_curator.json")) as SpaceMap;
    expect(map.sections.map((x) => x.id)).toEqual(["knn", "regression"]);
    expect(map.sections[1].children[0]).toMatchObject({ dependsOn: ["knn-principe"], summary: "Vu avec le k-NN." });
    // A prerequisite in another session is written on the card, and one arrow links the two sessions.
    const tree = parseCanvas(await io.read(engine.space("ML")!.generated.canvas))!;
    expect(tree.nodes.find((n) => n.id === "cc-m-biais-variance")!.text).toContain("*après* Principe du k-NN (1.1)");
    expect(tree.edges.some((e) => e.fromNode === "cc-g-knn" && e.toNode === "cc-g-regression")).toBe(true);
    expect(tree.edges.some((e) => e.fromNode === "cc-m-knn-principe" && e.toNode === "cc-m-biais-variance")).toBe(false);
  });

  it("moves a note an older version wrote at the session root into the notes folder, in learning order", async () => {
    write("ML/Semaine 2/1 - Distances.md", "---\ncurator: fiche\n---\n# Distances\nNorme L2.");
    write("ML/Semaine 2/Semaine 2.canvas", JSON.stringify({ nodes: [{ id: "cc-session", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" }], edges: [] }));
    write("ML/Semaine 2/3 - Ancienne fiche.md", "---\ncurator: fiche\n---\n# Ancienne fiche en français");
    const twoFiches: SynthesisPlan = {
      ...plan,
      fiches: [
        { ...plan.fiches[0], id: "distances", title: "Distances and norms", path: "ML/Semaine 2/1 - Distances.md", action: "extend", sources: [{ sourceId: "S2", what: "notes" }] },
        { ...plan.fiches[0], title: "2 - k-NN principle", dependsOn: ["distances"] },
      ],
    };
    const llm = new FakeLlm((req) => {
      if (req.label.startsWith("transcription")) return { description: "", transcript: "t", uncertain: [] };
      if (req.label.startsWith("vérification")) return { transcript: "t", corrections: [], uncertain: [] };
      if (req.label.startsWith("plan de synthèse")) return twoFiches;
      if (req.label.startsWith("rédaction")) return { content: `# ${req.label}\nNorme L2.`, summary: "" };
      if (req.label.startsWith("contrôle")) return { sources: [] };
      throw new Error(req.label);
    });
    const engine = new Engine(io, () => llm, { data, save: async () => undefined }, "Vault");
    const syn = new Synthesizer(engine);
    await engine.addSpace("ML", "", "learning");
    let job = await syn.plan(await syn.lotFromFolder(engine.space("ML")!, "ML/Semaine 2"), () => undefined);
    expect(job.plan.fiches.map((f) => f.path)).toEqual(["ML/Semaine 2/Fiches/01 - Distances and norms.md", "ML/Semaine 2/Fiches/02 - k-NN principle.md"]);
    expect(job.plan.fiches[0].moveFrom).toBe("ML/Semaine 2/1 - Distances.md");
    job = await syn.write(job, () => undefined);
    expect(job.written[0].before).toContain("Norme L2.");
    await syn.apply(job, () => undefined);
    expect(io.exists("ML/Semaine 2/1 - Distances.md")).toBe(false);
    // The 0.6 session canvas is retired: one skill tree per course.
    expect(io.exists("ML/Semaine 2/Sources/Anciens tableaux de bord/Semaine 2.canvas")).toBe(true);
    // A note an older version wrote that the new notes replace goes too.
    expect(io.exists("ML/Semaine 2/Sources/Anciennes fiches/3 - Ancienne fiche.md")).toBe(true);
    expect(await io.read("ML/Semaine 2/Fiches/01 - Distances and norms.md")).toContain("rédaction");
    const map = JSON.parse(await io.read("ML/_curator.json")) as SpaceMap;
    expect(map.sections[0].children.map((c) => [c.id, c.dependsOn])).toEqual([["distances", []], ["knn-principe", ["distances"]]]);
  });
});

describe("A course the student already organised", () => {
  it("keeps their study notes as notes of the tree, extends them in place and leaves their tools alone", async () => {
    write("LA/modules/M01 Vector spaces.md", "# M01 Vector spaces\n## Notions\nBasis, dimension.");
    write("LA/modules/M11 SVD.md", "# M11 SVD\n## Notions\nA = U Σ V^T.");
    write("LA/README.md", "# Pi course modules\nUse `learn M07`.");
    write("LA/00 Skill tree.canvas", '{"nodes":[],"edges":[]}');
    write("LA/2026-10-02 - Tableau - SVD.jpg", fs.readFileSync(path.join(__dirname, "fixtures/board.jpg")));
    const ids = new Map<string, string>();
    const llm = new FakeLlm((req) => {
      if (req.label.startsWith("transcription")) return { description: "tableau", transcript: "SVD au tableau", uncertain: [] };
      if (req.label.startsWith("vérification")) return { transcript: "SVD au tableau : rang = nombre de valeurs singulières", corrections: [], uncertain: [] };
      if (req.label.startsWith("plan de synthèse")) {
        for (const m of req.prompt.matchAll(/^### (S\d+) — (\S.*?)$/gm)) ids.set(m[2], m[1]);
        const id = (suffix: string) => [...ids].find(([p]) => p.endsWith(suffix))![1];
        return {
          ...plan,
          sources: [{ sourceId: id("README.md"), role: "outil", contributes: "", disposition: "ignore" }],
          module: { ...plan.module, id: "svd", title: "SVD", folder: "LA/modules" },
          fiches: [
            { ...plan.fiches[0], id: "m01", title: "M01 Vector spaces", path: "LA/modules/M01 Vector spaces.md", action: "keep", sources: [], dependsOn: [] },
            { ...plan.fiches[0], id: "m11", title: "M11 SVD", path: "LA/modules/M11 SVD.md", action: "extend", sources: [{ sourceId: id("SVD.jpg"), what: "tableau" }], dependsOn: ["m01"] },
          ],
        };
      }
      if (req.label.startsWith("rédaction")) return { content: "# M11 SVD\n## Notions\nA = U Σ V^T.\nRang = nombre de valeurs singulières.", summary: "" };
      if (req.label.startsWith("contrôle")) return { sources: [...ids.values()].map((sourceId) => ({ sourceId, covered: true, missing: [] })) };
      throw new Error(req.label);
    });
    const engine = new Engine(io, () => llm, { data, save: async () => undefined }, "Vault");
    const syn = new Synthesizer(engine);
    await engine.addSpace("LA", "", "learning");
    let job = await syn.plan(await syn.lotFromFolder(engine.space("LA")!, "LA"), () => undefined);
    expect(job.plan.fiches.map((f) => [f.action, f.path])).toEqual([["keep", "LA/modules/M01 Vector spaces.md"], ["extend", "LA/modules/M11 SVD.md"]]);
    expect(job.plan.fiches[1].moveFrom).toBeUndefined();
    expect(syn.disposition(job, ids.get("LA/README.md")!)).toBe("ignore");
    job = await syn.write(job, () => undefined);
    expect(job.written.map((w) => w.plan.id)).toEqual(["m11"]);
    const report = await syn.apply(job, () => undefined);
    expect(await io.read("LA/modules/M01 Vector spaces.md")).toBe("# M01 Vector spaces\n## Notions\nBasis, dimension.");
    expect(await io.read("LA/modules/M11 SVD.md")).toContain("Rang = nombre de valeurs singulières.");
    expect(await io.read("LA/README.md")).toContain("learn M07");
    expect(report.untouched.sort()).toEqual(["LA/README.md", "LA/modules/M01 Vector spaces.md", "LA/modules/M11 SVD.md"]);
    const map = JSON.parse(await io.read("LA/_curator.json")) as SpaceMap;
    expect(map.sections[0].children.map((c) => [c.id, c.dependsOn])).toEqual([["m01", []], ["m11", ["m01"]]]);
    expect(map.keptDashboards).toEqual(["LA/00 Skill tree.canvas"]);
  });
});

describe("Synthesizer on the layout of a real master's vault", () => {
  // DDDF = folder of courses; photos pasted into notes live in the attachments folder;
  // an older version left a week folder managed on its own with its photo notes in a local "99 Archive".
  const week = "DDDF/Machine Learning I/02 Nearest Neighbors";
  const notebook = JSON.stringify({
    metadata: { kernelspec: { language: "python" } },
    cells: [
      { cell_type: "markdown", source: ["# Lab 2 — broadcasting\n"] },
      { cell_type: "code", source: ["def knn(X, x):\n", "    return ((X - x) ** 2).sum(1)"], outputs: [{ output_type: "stream", text: ["ok\n"] }, { output_type: "display_data", data: { "image/png": "AAAA" } }] },
    ],
  });

  beforeEach(() => {
    const board = fs.readFileSync(path.join(__dirname, "fixtures/board.jpg"));
    write("Attachments/IMG_20261012_123151.jpg", board);
    write("Attachments/IMG_20261012_123205.jpg", Buffer.concat([board, Buffer.from("x")]));
    write(`${week}/99 Archive/Photos CM.md`, "![[IMG_20261012_123151.jpg]]![[IMG_20261012_123205.jpg]]");
    write(`${week}/CM - Prise de notes.md`, "Comprendre le saut paramétrique -> non paramétrique\n![[Tableau LAR.jpg]]");
    write("DDDF/Linear Algebra & Regression/Photos/Tableau LAR.jpg", board);
    write(`${week}/02 PC/Lab2_KNN.ipynb`, notebook);
    write(`${week}/02 PC/data.csv`, "a,b\n1,2\n3,4");
    write("DDDF/À faire.md", "# À faire");
    write("DDDF/99 Archive/IMG_20261012_123151 — transcription.md", "![[IMG_20261012_123151.jpg]]\n\nAncienne transcription : règle du vote majoritaire");
  });

  function realSetup(uncovered?: string) {
    const ids = new Map<string, string>();
    const llm = new FakeLlm((req) => {
      if (req.label.startsWith("transcription")) return { description: "tableau", transcript: `transcription de ${req.label}`, uncertain: [] };
      if (req.label.startsWith("vérification")) return { transcript: `vérifiée : ${req.label}`, corrections: [], uncertain: [] };
      if (req.label.startsWith("plan de synthèse")) {
        for (const m of req.prompt.matchAll(/^### (S\d+) — (\S.*?)(?: \(photo insérée dans S\d+\))?$/gm)) ids.set(m[2], m[1]);
        const id = (suffix: string) => [...ids].find(([p]) => p.endsWith(suffix))![1];
        return {
          ...plan,
          sources: [{ sourceId: id("Lab2_KNN.ipynb"), role: "notebook", contributes: "implémentation", disposition: "integrate" }],
          module: { ...plan.module, folder: "02 k-NN" },
          fiches: [{ ...plan.fiches[0], path: "02 k-NN/1 - Principe du k-NN", dependsOn: [], sources: [{ sourceId: id("Photos CM.md"), what: "tableau" }, { sourceId: id("CM - Prise de notes.md"), what: "notes" }] }],
        };
      }
      if (req.label.startsWith("rédaction")) return { content: "# Principe du k-NN\nVote majoritaire.", summary: "" };
      if (req.label.startsWith("contrôle")) {
        return {
          sources: [...ids].map(([p, sourceId]) =>
            uncovered && p.endsWith(uncovered) ? { sourceId, covered: false, missing: [{ item: "illisible", fiche: "" }] } : { sourceId, covered: true, missing: [] },
          ),
        };
      }
      if (req.label.startsWith("complément")) return { content: "# Principe du k-NN\nVote majoritaire.", summary: "" };
      throw new Error(`unexpected ${req.label}`);
    });
    const engine = new Engine(io, () => llm, { data, save: async () => undefined }, "Vault");
    return { llm, engine, syn: new Synthesizer(engine) };
  }

  it("gives each course its own skill tree and transcribes the photos pasted into notes", async () => {
    const { llm, engine, syn } = realSetup();
    await engine.addSpace("DDDF", "Dossier contenant mes cours de master. Un sous-dossier par cours.", "learning");
    await engine.addSpace(week, "Cours 2, k-NN", "learning");
    const oldCanvas = data.settings.spaces.find((s) => s.folder === week)!.canvas;
    write(oldCanvas, '{"nodes":[],"edges":[]}');
    expect(data.settings.spaces[0].level).toBe("programme");

    expect(await syn.courseFor("DDDF/À faire.md")).toBeNull();
    const course = (await syn.courseFor(`${week}/CM - Prise de notes.md`))!;
    expect(course.folder).toBe("DDDF/Machine Learning I");
    expect(data.settings.spaces.find((s) => s.folder === course.folder)).toMatchObject({ mode: "learning", level: "course" });
    expect(syn.coursesOf("DDDF")).toEqual(["DDDF/Linear Algebra & Regression", "DDDF/Machine Learning I"]);

    const lots = await syn.courseLots(course);
    expect(lots.map((l) => l.folder)).toEqual([week]);
    expect(lots[0].files.map((f) => f.path).sort()).toEqual([`${week}/02 PC/Lab2_KNN.ipynb`, `${week}/02 PC/data.csv`, `${week}/99 Archive/Photos CM.md`, `${week}/CM - Prise de notes.md`]);

    let job = await syn.plan(lots[0], () => undefined);
    // The two photos, stored in the attachments folder, are sources of their own, attached to their note.
    const note = job.sources.find((s) => s.path.endsWith("Photos CM.md"))!;
    const photos = job.sources.filter((s) => s.kind === "image");
    // A photo of another course pasted into the note is only referenced: it stays with its course.
    expect(photos.map((p) => p.path).sort()).toEqual(["Attachments/IMG_20261012_123151.jpg", "Attachments/IMG_20261012_123205.jpg"]);
    expect(photos.every((p) => p.embeddedIn === note.id)).toBe(true);
    expect(llm.calls.filter((c) => c.label.startsWith("transcription"))).toHaveLength(2);
    // The older version's transcription is a draft to check, not ignored.
    expect(llm.calls.find((c) => c.label === "transcription de IMG_20261012_123151.jpg")!.prompt).toContain("Ancienne transcription : règle du vote majoritaire");
    const planCall = llm.calls.find((c) => c.label.startsWith("plan de synthèse"))!;
    expect(planCall.prompt).toContain(`⟨photo transcrite : voir ${photos[0].id}⟩`);
    expect(planCall.prompt).toContain("def knn(X, x):");
    expect(planCall.prompt).not.toContain('"cell_type"');
    expect(planCall.prompt).toContain("(pour l'ensemble des cours) Dossier contenant mes cours de master.");
    // The photos follow their note into the fiche; the notebook and the data stay in place.
    expect(job.plan.fiches[0].sources.map((x) => x.sourceId)).toEqual(expect.arrayContaining(photos.map((p) => p.id)));
    expect(job.plan.fiches[0].path).toBe(`${week}/Fiches/01 - Principe du k-NN.md`);
    const nb = job.sources.find((s) => s.kind === "notebook")!;
    expect(syn.disposition(job, nb.id)).toBe("keep");
    expect(job.unassigned).toEqual([]);

    job = await syn.write(job, () => undefined);
    const report = await syn.apply(job, () => undefined);
    expect(report.archived.sort()).toEqual(["Attachments/IMG_20261012_123151.jpg", "Attachments/IMG_20261012_123205.jpg", `${week}/99 Archive/Photos CM.md`, `${week}/CM - Prise de notes.md`]);
    expect(report.kept.sort()).toEqual([`${week}/02 PC/Lab2_KNN.ipynb`, `${week}/02 PC/data.csv`]);
    expect(io.exists(`${week}/Sources/IMG_20261012_123151.jpg`)).toBe(true);
    // The notebook and its data move together, so its relative paths still work.
    expect(report.moved[`${week}/02 PC/Lab2_KNN.ipynb`]).toBe(`${week}/Sources/02 PC/Lab2_KNN.ipynb`);
    expect(report.moved[`${week}/02 PC/data.csv`]).toBe(`${week}/Sources/02 PC/data.csv`);
    // What the older version generated for the week is retired; emptied folders go.
    expect(io.exists(`${week}/Sources/Anciens tableaux de bord/${oldCanvas.split("/").pop()}`)).toBe(true);
    expect(data.settings.spaces.some((s) => s.folder === week)).toBe(false);
    expect(io.exists(`${week}/02 PC`)).toBe(false);
    expect(io.exists(`${week}/99 Archive`)).toBe(false);
    expect(io.listFiles().filter((f) => dirname(f.path) === week)).toEqual([]);
    // The skill tree is the course's, not the whole master's; the notebook is reachable from it.
    expect(io.exists("DDDF/_curator.json")).toBe(false);
    const map = JSON.parse(await io.read("DDDF/Machine Learning I/_curator.json")) as SpaceMap;
    const module = map.sections.find((s) => s.id === "knn")!;
    expect(module.resources.find((r) => r.path.endsWith("Lab2_KNN.ipynb"))).toMatchObject({ role: "code", path: `${week}/Sources/02 PC/Lab2_KNN.ipynb` });
    expect(map.language).toBe("English");
  });

  it("archives a note of photos only with all its photos", async () => {
    const { engine, syn } = realSetup("123205.jpg");
    await engine.addSpace("DDDF", "Un sous-dossier par cours.", "learning");
    const course = (await syn.courseFor(week))!;
    let job = await syn.plan(await syn.lotFromFolder(course, week), () => undefined);
    job = await syn.write(job, () => undefined);
    expect(job.coverage.find((c) => c.path.endsWith("Photos CM.md"))).toMatchObject({ covered: false });
    const report = await syn.apply(job, () => undefined);
    expect(report.pending.sort()).toEqual(["Attachments/IMG_20261012_123205.jpg", `${week}/99 Archive/Photos CM.md`]);
    expect(report.archived).toContain("Attachments/IMG_20261012_123151.jpg");
    expect(io.exists(`${week}/99 Archive/Photos CM.md`)).toBe(true);
  });
});

describe("reading notes as stored", () => {
  it("finds every kind of embed and ignores plain links and web images", async () => {
    const { embedsOf } = await import("../src/learn/content");
    const md = "![[Pasted image 2026.png|308]] ![[a.jpg#x]] [[lien.jpg]] ![alt](Attachments/photo%201.png) ![w](https://x.org/i.png)";
    expect(embedsOf(md).map((e) => e.link)).toEqual(["Pasted image 2026.png", "a.jpg", "Attachments/photo 1.png"]);
  });
  it("detects a folder of courses from what the user said", async () => {
    const { guessLevel } = await import("../src/core/settings");
    expect(guessLevel("Dossier contenant mes cours de master. Un sous-dossier par cours.")).toBe("programme");
    expect(guessLevel("Cours 2 du cours de Machine Learning, focalisé sur les k-NN.")).toBe("course");
  });
});
