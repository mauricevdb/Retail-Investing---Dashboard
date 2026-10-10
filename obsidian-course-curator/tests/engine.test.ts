import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseCanvas } from "../src/core/canvas";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { CourseMap } from "../src/core/types";
import { Engine, PluginData } from "../src/engine";
import { DigestAnswer, IncrementalAnswer, OnboardAnswer } from "../src/llm/schemas";
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
    return this.answers(req) as T;
  }
}

function digestAll(req: LlmRequest): DigestAnswer {
  const paths = [...req.prompt.matchAll(/### Fichier \d+ : (.+)/g)].map((m) => m[1]);
  return {
    files: paths.map((p) => ({
      path: p,
      docType: p.endsWith(".jpg") ? "tableau" : p.includes("TD") ? "exercices" : p.includes("Dashboard") ? "dashboard" : "cours",
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
  data = { settings: { ...DEFAULT_SETTINGS }, ledger: {}, journal: [] };
  write("Taux/Cours 1 - Intro.pdf");
  write("Taux/TD1.pdf");
  write("Taux/IMG_2034.jpg");
  write("Taux/Dashboard.md", "# Mon dashboard\n- [[Cours 1 - Intro]]");
  write("Taux/notes.md", "# Notes\nDuration");
});

const onboardAnswer: OnboardAnswer = {
  summary: "Cours en vrac, rangé par module.",
  questions: [],
  dashboards: [{ path: "Taux/Dashboard.md", decision: "merge", rationale: "liens repris" }],
  ops: [
    { kind: "move", source: "Taux/Cours 1 - Intro.pdf", target: "Taux/01 Intro/Cours 1 - Intro.pdf", content: null, reason: "module 1" },
    { kind: "move", source: "Taux/TD1.pdf", target: "Taux/01 Intro/TD 1 - Actualisation.pdf", content: null, reason: "module 1" },
    { kind: "move", source: "Taux/IMG_2034.jpg", target: "Taux/01 Intro/S01 - Tableau - Taux", content: null, reason: "nom opaque" },
    { kind: "transcribe", source: "Taux/01 Intro/S01 - Tableau - Taux.jpg", target: null, content: null, reason: "transcription" },
    { kind: "move", source: "Taux/notes.md", target: "Taux/02 Duration/notes.md", content: null, reason: "module 2" },
  ],
  courseMap: {
    summary: "Taux d'intérêt.",
    modules: [
      {
        id: "m01-intro",
        title: "Introduction",
        summary: "Actualisation",
        concepts: ["Actualisation"],
        prerequisites: [],
        folder: "Taux/01 Intro",
        resources: [
          { path: "Taux/01 Intro/Cours 1 - Intro.pdf", role: "cours", label: "Cours 1" },
          { path: "Taux/01 Intro/TD 1 - Actualisation.pdf", role: "exercices", label: "TD 1" },
          { path: "Taux/01 Intro/S01 - Tableau - Taux.jpg", role: "tableau", label: "Tableau S1" },
        ],
        children: [],
      },
      {
        id: "m02-duration",
        title: "Duration",
        summary: "",
        concepts: ["Duration"],
        prerequisites: ["m01-intro"],
        folder: "Taux/02 Duration",
        resources: [{ path: "Taux/02 Duration/notes.md", role: "notes", label: "Notes" }],
        children: [],
      },
    ],
    transverse: [],
  },
};

describe("Engine", () => {
  it("onboards a course, aggregates a new document, and undoes", async () => {
    const llm = new FakeLlm((req) => {
      if (req.label.startsWith("lecture")) return digestAll(req);
      if (req.label.startsWith("structure")) return onboardAnswer;
      if (req.label.startsWith("agrégation")) {
        const answer: IncrementalAnswer = {
          summary: "TD 2 rejoint le module Duration.",
          questions: [],
          ops: [
            { kind: "move", source: "Taux/TD2.pdf", target: "Taux/02 Duration/TD 2 - Duration.pdf", content: null, reason: "module 2" },
            { kind: "append_note", source: null, target: "Taux/02 Duration/notes.md", content: "Voir [[Taux/02 Duration/TD 2 - Duration.pdf|TD 2]].", reason: "lien" },
          ],
          newModules: [],
          assignments: [{ path: "Taux/02 Duration/TD 2 - Duration.pdf", moduleId: "m02-duration", role: "exercices", label: "TD 2" }],
          conceptUpdates: [{ moduleId: "m02-duration", concepts: ["Convexité"] }],
        };
        return answer;
      }
      throw new Error(`unexpected ${req.label}`);
    });
    const engine = new Engine(io, () => llm, { data, save: async () => undefined });

    // --- Onboarding
    const course = engine.scan().courses[0];
    expect(course.dashboards).toEqual(["Taux/Dashboard.md"]);
    const prepared = await engine.planOnboarding(course, () => undefined);
    // Merge decision without explicit op → archive op added by the engine.
    expect(prepared.checked.at(-1)!.kind).toBe("archive");
    expect(prepared.checked.map((c) => c.error)).toEqual([null, null, null, null, null, null]);
    expect(llm.calls.flatMap((c) => c.attachments ?? []).map((a) => a.path).sort()).toEqual(["Taux/Cours 1 - Intro.pdf", "Taux/IMG_2034.jpg", "Taux/TD1.pdf"]);

    const report = await engine.apply(prepared, prepared.checked.map(() => true), () => undefined);
    expect(report.failed).toEqual([]);
    expect(report.dropped).toEqual([]);
    expect(io.exists("Taux/01 Intro/S01 - Tableau - Taux.jpg")).toBe(true);
    expect(await io.read("Taux/01 Intro/S01 - Tableau - Taux — transcription.md")).toContain("$r = \\ln(1+R)$");
    expect(io.exists("Taux/99 Archive/Dashboard.md")).toBe(true);
    const canvas = parseCanvas(await io.read("Taux/Taux — Skill tree.canvas"))!;
    expect(canvas.edges.some((e) => e.id === "cc-e-m01-intro--m02-duration")).toBe(true);
    expect(await io.read("Taux/Taux — Index.md")).toContain("[[Taux/01 Intro/TD 1 - Actualisation.pdf|TD 1]]");
    // The transcription note is filed next to its photo even though Claude did not list it.
    const onboarded = JSON.parse(await io.read("Taux/_curator.json")) as CourseMap;
    expect(onboarded.modules[0].resources.map((r) => r.label)).toEqual(["Cours 1", "TD 1", "Tableau S1", "Transcription — Tableau S1"]);
    expect(engine.newFiles(engine.scan().courses[0])).toEqual([]);
    // Digests followed the renamed files.
    expect(data.ledger["Taux/01 Intro/TD 1 - Actualisation.pdf"].digest?.docType).toBe("exercices");

    // --- A new document arrives
    write("Taux/TD2.pdf");
    const organised = engine.scan().courses[0];
    const fresh = engine.newFiles(organised);
    expect(fresh.map((f) => f.path)).toEqual(["Taux/TD2.pdf"]);
    const inc = await engine.planIncremental(organised, fresh, () => undefined);
    expect(inc.checked.map((c) => c.error)).toEqual([null, null]);
    await engine.apply(inc, [true, true], () => undefined);
    const map = JSON.parse(await io.read("Taux/_curator.json")) as CourseMap;
    expect(map.modules[1].resources.map((r) => r.label)).toEqual(["Notes", "TD 2"]);
    expect(map.modules[1].concepts).toEqual(["Duration", "Convexité"]);
    expect(await io.read("Taux/02 Duration/notes.md")).toContain("Voir [[Taux/02 Duration/TD 2 - Duration.pdf|TD 2]].");

    // --- Undo the aggregation, then the onboarding
    const undone = await engine.undoLast();
    expect(undone?.warnings).toEqual([]);
    expect(io.exists("Taux/TD2.pdf")).toBe(true);
    expect(await io.read("Taux/02 Duration/notes.md")).toBe("# Notes\nDuration");
    await engine.undoLast();
    expect(io.exists("Taux/IMG_2034.jpg")).toBe(true);
    expect(io.exists("Taux/Dashboard.md")).toBe(true);
    expect(io.exists("Taux/Taux — Skill tree.canvas")).toBe(false);
    expect(io.exists("Taux/01 Intro")).toBe(false);
  });

  it("re-applies only the selected ops and reconciles the map", async () => {
    const llm = new FakeLlm((req) => (req.label.startsWith("lecture") ? digestAll(req) : onboardAnswer));
    const engine = new Engine(io, () => llm, { data, save: async () => undefined });
    const prepared = await engine.planOnboarding(engine.scan().courses[0], () => undefined);
    const selected = prepared.checked.map((_, i) => i !== 1); // keep TD1.pdf where it is
    engine.recheck(prepared, prepared.plan.ops, selected);
    await engine.apply(prepared, selected, () => undefined);
    const map = JSON.parse(await io.read("Taux/_curator.json")) as CourseMap;
    expect(map.modules[0].resources.map((r) => r.path)).toContain("Taux/TD1.pdf");
  });

  it("removes folders emptied by the plan and recreates them on undo", async () => {
    write("Taux/TD/TD9.pdf");
    const answer: OnboardAnswer = {
      ...onboardAnswer,
      dashboards: [],
      ops: [{ kind: "move", source: "Taux/TD/TD9.pdf", target: "Taux/01 Intro/TD9.pdf", content: null, reason: "module 1" }],
    };
    const llm = new FakeLlm((req) => (req.label.startsWith("lecture") ? digestAll(req) : answer));
    const engine = new Engine(io, () => llm, { data, save: async () => undefined });
    const prepared = await engine.planOnboarding(engine.scan().courses[0], () => undefined);
    await engine.apply(prepared, [true], () => undefined);
    expect(io.exists("Taux/TD")).toBe(false);
    await engine.undoLast();
    expect(io.exists("Taux/TD/TD9.pdf")).toBe(true);
  });
});
