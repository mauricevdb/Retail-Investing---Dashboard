import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseCanvas } from "../src/core/canvas";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { SpaceMap } from "../src/core/types";
import { Engine, PluginData } from "../src/engine";
import { DigestAnswer, IncrementalAnswer, InitialAnswer } from "../src/llm/schemas";
import { LlmBackend, LlmRequest } from "../src/llm/types";
import { NodeIO } from "./nodeIO";

/** Scripted backend: answers by request label. */
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

function digestAll(req: LlmRequest): DigestAnswer {
  const paths = [...req.prompt.matchAll(/### Fichier \d+ : (.+)/g)].map((m) => m[1]);
  return {
    files: paths.map((p) => ({
      path: p,
      docType: p.endsWith(".jpg") ? "manuscrit" : p.includes("TD") ? "exercices" : p.includes("Dashboard") ? "dashboard" : "cours",
      title: path.basename(p),
      summary: "résumé",
      topics: ["taux"],
      sequence: null,
      transcript: p.endsWith(".jpg") ? "Formule : $r = \\ln(1+R)$" : null,
    })),
  };
}

let root: string;
let io: NodeIO;
let data: PluginData;
const write = (p: string, content = "x") => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), content);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "curator-"));
  io = new NodeIO(root);
  data = { settings: { ...DEFAULT_SETTINGS, spaces: [] }, ledger: {}, journal: [] };
  write("Taux/Cours 1 - Intro.pdf");
  write("Taux/TD1.pdf");
  write("Taux/IMG_2034.jpg");
  write("Taux/Dashboard.md", "# Mon dashboard\n- [[Cours 1 - Intro]]");
  write("Taux/notes.md", "# Notes\nDuration");
});

const initialAnswer: InitialAnswer = {
  understanding: { kind: "cours", purpose: "Réviser le cours de taux.", usage: "Avant le partiel.", principle: "Un dossier par module." },
  summary: "Cours en vrac, rangé par module.",
  questions: ["Le TD 1 va-t-il avec l'introduction ?"],
  changes: [],
  dashboards: [{ path: "Taux/Dashboard.md", decision: "merge", rationale: "liens repris" }],
  ops: [
    { kind: "move", source: "Taux/Cours 1 - Intro.pdf", target: "Taux/01 Intro/Cours 1 - Intro.pdf", content: null, reason: "module 1" },
    { kind: "move", source: "Taux/TD1.pdf", target: "Taux/01 Intro/TD 1 - Actualisation.pdf", content: null, reason: "module 1" },
    { kind: "move", source: "Taux/IMG_2034.jpg", target: "Taux/01 Intro/S01 - Tableau - Taux", content: null, reason: "nom opaque" },
    { kind: "transcribe", source: "Taux/01 Intro/S01 - Tableau - Taux.jpg", target: null, content: null, reason: "transcription" },
    { kind: "move", source: "Taux/notes.md", target: "Taux/02 Duration/notes.md", content: null, reason: "module 2" },
  ],
  map: {
    dashboardTitle: "Skill tree",
    linkKind: "prerequisite",
    summary: "Taux d'intérêt.",
    conventions: "Un dossier numéroté par module.",
    preferences: [],
    sections: [
      {
        id: "s01-intro",
        title: "Introduction",
        summary: "Actualisation",
        keywords: ["Actualisation"],
        dependsOn: [],
        folder: "Taux/01 Intro",
        resources: [
          { path: "Taux/01 Intro/Cours 1 - Intro.pdf", role: "cours", label: "Cours 1" },
          { path: "Taux/01 Intro/TD 1 - Actualisation.pdf", role: "exercices", label: "TD 1" },
          { path: "Taux/01 Intro/S01 - Tableau - Taux.jpg", role: "manuscrit", label: "Tableau S1" },
        ],
        children: [],
      },
      {
        id: "s02-duration",
        title: "Duration",
        summary: "",
        keywords: ["Duration"],
        dependsOn: ["s01-intro"],
        folder: "Taux/02 Duration",
        resources: [{ path: "Taux/02 Duration/notes.md", role: "notes", label: "Notes" }],
        children: [],
      },
    ],
    transverse: [],
  },
};

/** The revision: TD 1 goes to Duration instead, as the user answered. */
const revisedAnswer: InitialAnswer = structuredClone(initialAnswer);
revisedAnswer.questions = [];
revisedAnswer.changes = ["TD 1 rangé dans Duration, comme demandé."];
revisedAnswer.ops[1] = { kind: "move", source: "Taux/TD1.pdf", target: "Taux/02 Duration/TD 1 - Actualisation.pdf", content: null, reason: "réponse de l'utilisateur" };
revisedAnswer.map.preferences = ["Les TD vont avec le module qu'ils entraînent."];
revisedAnswer.map.sections[0].resources.splice(1, 1);
revisedAnswer.map.sections[1].resources.push({ path: "Taux/02 Duration/TD 1 - Actualisation.pdf", role: "exercices", label: "TD 1" });

function engineWith(answers: (req: LlmRequest) => unknown) {
  const llm = new FakeLlm(answers);
  const engine = new Engine(io, () => llm, { data, save: async () => undefined }, "Vault");
  return { llm, engine };
}

describe("Engine", () => {
  it("manages a folder: understands, revises with feedback, applies, aggregates, undoes", async () => {
    const { llm, engine } = engineWith((req) => {
      if (req.label.startsWith("lecture")) return digestAll(req);
      if (req.label.startsWith("plan pour")) return initialAnswer;
      if (req.label.startsWith("révision du plan")) return revisedAnswer;
      if (req.label.startsWith("agrégation") || req.label.startsWith("révision de l'agrégation")) {
        const answer: IncrementalAnswer = {
          summary: "TD 2 rejoint Duration.",
          questions: [],
          changes: [],
          ops: [
            { kind: "move", source: "Taux/TD2.pdf", target: "Taux/02 Duration/TD 2 - Duration.pdf", content: null, reason: "section 2" },
            { kind: "append_note", source: null, target: "Taux/02 Duration/notes.md", content: "Voir [[Taux/02 Duration/TD 2 - Duration.pdf|TD 2]].", reason: "lien" },
          ],
          newSections: [],
          assignments: [{ path: "Taux/02 Duration/TD 2 - Duration.pdf", sectionId: "s02-duration", role: "exercices", label: "TD 2" }],
          keywordUpdates: [{ sectionId: "s02-duration", keywords: ["Convexité"] }],
          preferences: ["Les TD vont avec le module qu'ils entraînent.", "Relier les TD aux notes."],
        };
        return answer;
      }
      throw new Error(`unexpected ${req.label}`);
    });

    expect(await engine.addSpace("Taux", "Mon cours de taux")).toBeNull();
    expect(await engine.addSpace("Taux")).toContain("déjà géré");
    expect(await engine.addSpace("Nope")).toContain("n'existe pas");

    // --- First proposal
    const space = engine.scan().spaces[0];
    expect(space.dashboards).toEqual(["Taux/Dashboard.md"]);
    const v1 = await engine.planInitial(space, () => undefined);
    expect(v1.round).toBe(1);
    expect(v1.plan.understanding.purpose).toBe("Réviser le cours de taux.");
    expect(v1.checked.at(-1)!.kind).toBe("archive"); // merge decision → archive op added
    const planCall = llm.calls.find((c) => c.label.startsWith("plan pour"))!;
    expect(planCall.prompt).toContain("Ce que l'utilisateur dit de ce dossier : Mon cours de taux");

    // --- The user answers the question, refuses an op and comments: revision
    const v2 = await engine.revise(
      v1,
      {
        answers: [{ question: v1.plan.questions[0], answer: "Non, il va avec Duration." }],
        opComments: [],
        refused: [4],
        edited: [],
        general: "Je préfère des noms courts.",
      },
      () => undefined,
    );
    const revision = llm.calls.at(-1)!;
    expect(revision.label).toBe("révision du plan pour Taux");
    expect(revision.prompt).toContain("→ réponse : Non, il va avec Duration.");
    expect(revision.prompt).toContain("Opération 5 refusée");
    expect(revision.prompt).toContain("Commentaire général : Je préfère des noms courts.");
    expect(revision.prompt).toContain('"purpose":"Réviser le cours de taux."'); // previous version sent back
    expect(v2.round).toBe(2);
    expect(v2.history).toHaveLength(1);
    expect(v2.plan.changes).toEqual(["TD 1 rangé dans Duration, comme demandé."]);

    // --- Validate for good
    const report = await engine.apply(v2, v2.checked.map(() => true), () => undefined);
    expect(report.failed).toEqual([]);
    expect(report.dropped).toEqual([]);
    expect(io.exists("Taux/02 Duration/TD 1 - Actualisation.pdf")).toBe(true);
    expect(await io.read("Taux/01 Intro/S01 - Tableau - Taux — transcription.md")).toContain("$r = \\ln(1+R)$");
    expect(io.exists("Taux/99 Archive/Dashboard.md")).toBe(true);
    const map = JSON.parse(await io.read("Taux/_curator.json")) as SpaceMap;
    expect(map).toMatchObject({ version: 2, kind: "cours", purpose: "Réviser le cours de taux.", conventions: "Un dossier numéroté par module." });
    expect(map.preferences).toEqual(["Les TD vont avec le module qu'ils entraînent."]);
    expect(map.sections[0].resources.map((r) => r.label)).toEqual(["Cours 1", "Tableau S1", "Transcription — Tableau S1"]);
    const canvas = parseCanvas(await io.read("Taux/Taux — Dashboard.canvas"))!;
    expect(canvas.edges.some((e) => e.id === "cc-e-s01-intro--s02-duration")).toBe(true);
    const index = await io.read("Taux/Taux — Index.md");
    expect(index).toContain("Mode d'emploi");
    expect(index).toContain("[[Taux/02 Duration/TD 1 - Actualisation.pdf|TD 1]]");
    expect(engine.newFiles(engine.scan().spaces[0])).toEqual([]);
    expect(data.ledger["Taux/02 Duration/TD 1 - Actualisation.pdf"].digest?.docType).toBe("exercices");

    // --- New material arrives
    write("Taux/TD2.pdf");
    const organised = engine.scan().spaces[0];
    const fresh = engine.newFiles(organised);
    expect(fresh.map((f) => f.path)).toEqual(["Taux/TD2.pdf"]);
    let inc = await engine.planIncremental(organised, fresh, () => undefined);
    // A revision of the aggregation plan goes through the same loop.
    inc = await engine.revise(inc, { answers: [], opComments: [{ index: 0, comment: "Nom plus court" }], refused: [], edited: [], general: "" }, () => undefined);
    expect(llm.calls.at(-1)!.label).toBe("révision de l'agrégation dans Taux");
    expect(llm.calls.at(-1)!.prompt).toContain("Sur l'opération 1 (move Taux/TD2.pdf → Taux/02 Duration/TD 2 - Duration.pdf) : Nom plus court");
    expect(inc.round).toBe(2);
    const incCall = llm.calls.find((c) => c.label.startsWith("agrégation"))!;
    expect(incCall.prompt).toContain("Un dossier numéroté par module."); // agreed conventions
    expect(incCall.prompt).toContain("- Les TD vont avec le module qu'ils entraînent."); // remembered preferences
    expect(inc.checked.map((c) => c.error)).toEqual([null, null]);
    await engine.apply(inc, [true, true], () => undefined);
    const map2 = JSON.parse(await io.read("Taux/_curator.json")) as SpaceMap;
    expect(map2.sections[1].resources.map((r) => r.label)).toEqual(["Notes", "TD 1", "TD 2"]);
    expect(map2.sections[1].keywords).toEqual(["Duration", "Convexité"]);
    expect(map2.preferences).toHaveLength(2);
    expect(await io.read("Taux/02 Duration/notes.md")).toContain("Voir [[Taux/02 Duration/TD 2 - Duration.pdf|TD 2]].");

    // --- Undo the aggregation, then the organisation
    expect((await engine.undoLast())?.warnings).toEqual([]);
    expect(io.exists("Taux/TD2.pdf")).toBe(true);
    expect(await io.read("Taux/02 Duration/notes.md")).toBe("# Notes\nDuration");
    await engine.undoLast();
    expect(io.exists("Taux/IMG_2034.jpg")).toBe(true);
    expect(io.exists("Taux/Dashboard.md")).toBe(true);
    expect(io.exists("Taux/Taux — Dashboard.canvas")).toBe(false);
    expect(io.exists("Taux/01 Intro")).toBe(false);
  });

  it("re-applies only the selected ops and reconciles the map", async () => {
    const { engine } = engineWith((req) => (req.label.startsWith("lecture") ? digestAll(req) : initialAnswer));
    await engine.addSpace("Taux");
    const prepared = await engine.planInitial(engine.scan().spaces[0], () => undefined);
    const selected = prepared.checked.map((_, i) => i !== 1); // keep TD1.pdf where it is
    engine.recheck(prepared, prepared.plan.ops, selected);
    await engine.apply(prepared, selected, () => undefined);
    const map = JSON.parse(await io.read("Taux/_curator.json")) as SpaceMap;
    expect(map.sections[0].resources.map((r) => r.path)).toContain("Taux/TD1.pdf");
  });

  it("removes folders emptied by the plan and recreates them on undo", async () => {
    write("Taux/TD/TD9.pdf");
    const answer: InitialAnswer = {
      ...initialAnswer,
      dashboards: [],
      ops: [{ kind: "move", source: "Taux/TD/TD9.pdf", target: "Taux/01 Intro/TD9.pdf", content: null, reason: "module 1" }],
    };
    const { engine } = engineWith((req) => (req.label.startsWith("lecture") ? digestAll(req) : answer));
    await engine.addSpace("Taux");
    const prepared = await engine.planInitial(engine.scan().spaces[0], () => undefined);
    await engine.apply(prepared, [true], () => undefined);
    expect(io.exists("Taux/TD")).toBe(false);
    await engine.undoLast();
    expect(io.exists("Taux/TD/TD9.pdf")).toBe(true);
  });

  it("keeps managed folders in sync when they are renamed", async () => {
    const { engine } = engineWith(() => ({}));
    await engine.addSpace("Taux");
    await io.move("Taux", "Finance/Taux");
    expect(data.settings.spaces[0]).toMatchObject({ folder: "Finance/Taux", canvas: "Finance/Taux/Taux — Dashboard.canvas" });
  });

  it("merges the transcribed content of photos into the matching note", async () => {
    write("Taux/CM1 - Notes.md", "# CM1\nIntroduction aux taux.");
    const answer: InitialAnswer = {
      ...initialAnswer,
      dashboards: [],
      questions: [],
      ops: [
        { kind: "move", source: "Taux/IMG_2034.jpg", target: "Taux/Photos/2026-10-05 - Tableau - Taux.jpg", content: null, reason: "nom opaque" },
        { kind: "integrate", source: null, sources: ["Taux/Photos/2026-10-05 - Tableau - Taux.jpg"], target: "Taux/CM1 - Notes.md", content: null, reason: "tableau du CM1" },
      ],
    };
    const { llm, engine } = engineWith((req) => {
      if (req.label.startsWith("lecture")) return digestAll(req);
      if (req.label.startsWith("intégration")) {
        return { content: "# CM1\nIntroduction aux taux.\n\n## Taux continu\n$r = \\ln(1+R)$ ([[Taux/Photos/2026-10-05 - Tableau - Taux.jpg|📷]])", summary: "ajout" };
      }
      return answer;
    });
    await engine.addSpace("Taux");
    const prepared = await engine.planInitial(engine.scan().spaces[0], () => undefined);
    const merge = llm.calls.find((c) => c.label.startsWith("intégration"))!;
    expect(merge.prompt).toContain("Introduction aux taux."); // the note as it is
    expect(merge.prompt).toContain("Formule : $r = \\ln(1+R)$"); // the transcription from the digest
    expect(merge.prompt).toContain("### Taux/Photos/2026-10-05 - Tableau - Taux.jpg"); // linked by its final path
    expect(prepared.checked[1]).toMatchObject({ error: null, warning: null, before: "# CM1\nIntroduction aux taux." });

    // A revision that keeps the same integration reuses the prepared merge.
    const calls = llm.calls.length;
    await engine.revise(prepared, { answers: [], opComments: [], refused: [], edited: [], general: "ok" }, () => undefined);
    expect(llm.calls.slice(calls).map((c) => c.label)).toEqual(["révision du plan pour Taux"]);

    await engine.apply(prepared, [true, true], () => undefined);
    const note = await io.read("Taux/CM1 - Notes.md");
    expect(note).toContain("## Taux continu");
    expect(io.exists("Taux/Photos/2026-10-05 - Tableau - Taux.jpg")).toBe(true);
    expect(io.exists("Taux/Photos/2026-10-05 - Tableau - Taux — transcription.md")).toBe(false);
    await engine.undoLast();
    expect(await io.read("Taux/CM1 - Notes.md")).toBe("# CM1\nIntroduction aux taux.");
  });

  it("flags a merge that drops lines of the note", async () => {
    write("Taux/CM1 - Notes.md", "# CM1\nIntroduction aux taux.\nUne remarque importante.");
    const answer: InitialAnswer = {
      ...initialAnswer,
      dashboards: [],
      ops: [{ kind: "integrate", source: null, sources: ["Taux/IMG_2034.jpg"], target: "Taux/CM1 - Notes.md", content: null, reason: "r" }],
    };
    const { engine } = engineWith((req) =>
      req.label.startsWith("lecture") ? digestAll(req) : req.label.startsWith("intégration") ? { content: "# CM1\nIntroduction aux taux.\nAjout", summary: "" } : answer,
    );
    await engine.addSpace("Taux");
    const prepared = await engine.planInitial(engine.scan().spaces[0], () => undefined);
    expect(prepared.checked[0].warning).toContain("1 ligne(s) de la fiche actuelle n'apparaissent plus");
  });
});
