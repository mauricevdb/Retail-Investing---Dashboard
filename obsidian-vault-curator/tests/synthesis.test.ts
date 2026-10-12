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
    expect(archive).toContain("Gardé en place");

    const map = JSON.parse(await io.read("ML/_curator.json")) as SpaceMap;
    const module = map.sections.find((s) => s.id === "knn")!;
    expect(module.children.map((c) => c.id)).toEqual(["knn-principe"]);
    expect(module.children[0].resources[0]).toMatchObject({ path: "ML/Semaine 2/Fiches/01 - Principe du k-NN.md", role: "fiche" });
    expect(module.resources.some((r) => r.role === "archive")).toBe(true);
    expect(module.resources[0]).toMatchObject({ path: "ML/Semaine 2/Semaine 2.canvas", role: "dashboard" });
    expect(engine.space("ML")!.generated.canvas).toBe("ML/00 Skill tree — ML.canvas");
    expect(parseCanvas(await io.read(engine.space("ML")!.generated.canvas))!.nodes.some((n) => n.id === "cc-m-knn-principe")).toBe(true);
    // The session canvas: the notes (outputs) then the sources (inputs), and a way back to the course.
    const session = parseCanvas(await io.read("ML/Semaine 2/Semaine 2.canvas"))!;
    expect(session.nodes.find((n) => n.id === "cc-f-knn-principe")).toMatchObject({ type: "file", file: "ML/Semaine 2/Fiches/01 - Principe du k-NN.md" });
    expect(session.nodes.some((n) => n.type === "file" && n.file === report.archiveDoc)).toBe(true);
    expect(session.nodes.find((n) => n.id === "cc-session")!.text).toContain("[[ML/00 Skill tree — ML.canvas|Skill tree du cours]]");

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
  it("moves a note an older version wrote at the session root into the notes folder, in learning order", async () => {
    write("ML/Semaine 2/1 - Distances.md", "---\ncurator: fiche\n---\n# Distances\nNorme L2.");
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
    expect(await io.read("ML/Semaine 2/Fiches/01 - Distances and norms.md")).toContain("rédaction");
    const session = parseCanvas(await io.read("ML/Semaine 2/Semaine 2.canvas"))!;
    expect(session.edges.map((e) => e.id)).toEqual(["cc-e-distances--knn-principe"]);
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
    write(`${week}/CM - Prise de notes.md`, "Comprendre le saut paramétrique -> non paramétrique");
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
    expect(syn.coursesOf("DDDF")).toEqual(["DDDF/Machine Learning I"]);

    const lots = await syn.courseLots(course);
    expect(lots.map((l) => l.folder)).toEqual([week]);
    expect(lots[0].files.map((f) => f.path).sort()).toEqual([`${week}/02 PC/Lab2_KNN.ipynb`, `${week}/02 PC/data.csv`, `${week}/99 Archive/Photos CM.md`, `${week}/CM - Prise de notes.md`]);

    let job = await syn.plan(lots[0], () => undefined);
    // The two photos, stored in the attachments folder, are sources of their own, attached to their note.
    const note = job.sources.find((s) => s.path.endsWith("Photos CM.md"))!;
    const photos = job.sources.filter((s) => s.kind === "image");
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
    expect(io.listFiles().filter((f) => dirname(f.path) === week).map((f) => f.path)).toEqual([`${week}/02 Nearest Neighbors.canvas`]);
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
