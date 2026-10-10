import { describe, expect, it } from "vitest";
import { buildCanvas, levels, readStatuses } from "../src/core/canvas";
import { END, mergeIndex, START } from "../src/core/indexNote";
import { applyPatch } from "../src/core/mapMerge";
import { sanitizePath, uniquePath } from "../src/core/paths";
import { checkPlan, PlanContext, reconcileMap, renameInMap } from "../src/core/plan";
import { scanVault } from "../src/core/scan";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { CourseMap, ModuleNode, PlanOp } from "../src/core/types";

const f = (path: string) => ({ path, size: 1000, mtime: 1 });
const op = (kind: PlanOp["kind"], source: string | null, target: string | null, content: string | null = null): PlanOp => ({ kind, source, target, content, reason: "test" });
const mod = (id: string, extra: Partial<ModuleNode> = {}): ModuleNode => ({
  id,
  title: id,
  summary: "",
  concepts: [],
  prerequisites: [],
  folder: null,
  resources: [],
  children: [],
  ...extra,
});
const map = (modules: ModuleNode[], extra: Partial<CourseMap> = {}): CourseMap => ({
  version: 1,
  course: "Finance",
  folder: "Finance",
  summary: "",
  modules,
  transverse: [],
  keptDashboards: [],
  updatedAt: "2026-10-10T00:00:00Z",
  ...extra,
});

const ctx: PlanContext = { courseFolder: "Finance", inboxFolder: "📥 Inbox", archiveFolder: "99 Archive", protectedPaths: ["Finance/Finance — Skill tree.canvas", "Finance/Finance — Index.md"] };

describe("paths", () => {
  it("sanitises and de-duplicates", () => {
    expect(sanitizePath("/Finance/../TD: 1?.pdf")).toBe("Finance/TD 1 .pdf");
    expect(uniquePath("a/b.md", (p) => p === "a/b.md" || p === "a/b (2).md")).toBe("a/b (3).md");
  });
});

describe("scanVault", () => {
  it("finds courses, dashboards, inbox and structure signals", () => {
    const files = [
      f("Finance/Cours 1.pdf"),
      f("Finance/TD/TD1.pdf"),
      f("Finance/Dashboard.md"),
      f("Finance/Finance — Skill tree.canvas"),
      f("Finance/99 Archive/old.md"),
      f("Stats/notes.md"),
      f("📥 Inbox/scan.pdf"),
      f("Templates/t.md"),
    ];
    const folders = ["Finance", "Finance/TD", "Finance/99 Archive", "Stats", "📥 Inbox", "Templates"];
    const scan = scanVault(files, folders, DEFAULT_SETTINGS);
    expect(scan.courses.map((c) => c.name)).toEqual(["Finance", "Stats"]);
    const fin = scan.courses[0];
    expect(fin.files.map((x) => x.path)).toEqual(["Finance/Cours 1.pdf", "Finance/TD/TD1.pdf", "Finance/Dashboard.md"]);
    expect(fin.dashboards).toEqual(["Finance/Dashboard.md"]);
    expect(fin.structure.looseFiles).toBe(2);
    expect(scan.inbox.map((x) => x.path)).toEqual(["📥 Inbox/scan.pdf"]);
  });
});

describe("checkPlan", () => {
  const state = {
    files: ["Finance/IMG_1.jpg", "Finance/TD/TD1.pdf", "Finance/TD/TD2.pdf", "Finance/notes.md", "📥 Inbox/x.pdf"],
    folders: ["Finance", "Finance/TD", "📥 Inbox"],
  };

  it("simulates ops in order, including folder moves", () => {
    const checked = checkPlan(
      [op("move", "Finance/TD", "Finance/01 Intro/Exercices"), op("move", "Finance/01 Intro/Exercices/TD1.pdf", "Finance/01 Intro/Exercices/TD 1 - Taux.pdf")],
      state,
      ctx,
    );
    expect(checked.map((c) => c.error)).toEqual([null, null]);
  });

  it("rejects what would lose or overwrite data", () => {
    const checked = checkPlan(
      [
        op("move", "Finance/absent.pdf", "Finance/x.pdf"),
        op("move", "Finance/TD/TD1.pdf", "Finance/TD/TD2.pdf"),
        op("move", "Finance/TD", "Finance/TD/sub"),
        op("append_note", null, "Finance/TD/TD1.pdf", "x"),
        op("move", "Finance/notes.md", "Finance/Finance — Index.md"),
        op("move", "Finance/notes.md", "Autre cours/notes.md"),
      ],
      state,
      ctx,
    );
    expect(checked.map((c) => c.error)).toEqual([
      "source introuvable",
      "la destination existe déjà",
      "dossier déplacé dans lui-même",
      "seules les notes .md peuvent être complétées",
      "nom réservé au plugin",
      null, // a course-relative path is resolved inside the course
    ]);
    expect(checked[5].target).toBe("Finance/Autre cours/notes.md");
  });

  it("computes archive targets, keeps extensions, accepts inbox sources", () => {
    const checked = checkPlan(
      [op("archive", "Finance/notes.md", null), op("move", "Finance/IMG_1.jpg", "Finance/Images/S01 - Tableau"), op("move", "📥 Inbox/x.pdf", "Finance/x.pdf")],
      state,
      ctx,
    );
    expect(checked[0].target).toBe("Finance/99 Archive/notes.md");
    expect(checked[1].target).toBe("Finance/Images/S01 - Tableau.jpg");
    expect(checked[2].error).toBeNull();
  });

  it("recognises paths Claude wrote without the emoji or with another case", () => {
    const checked = checkPlan([op("move", "Inbox/x.pdf", "Finance/x.pdf"), op("append_note", null, "finance/NOTES.md", "lien")], state, ctx);
    expect(checked[0].source).toBe("📥 Inbox/x.pdf");
    expect(checked[0].error).toBeNull();
    expect(checked[1].target).toBe("Finance/notes.md");
  });

  it("fills transcriptions from the image's original path", () => {
    const checked = checkPlan(
      [op("move", "Finance/IMG_1.jpg", "Finance/Images/S01.jpg"), op("transcribe", "Finance/Images/S01.jpg", null)],
      state,
      ctx,
      undefined,
      (origin, current) => (origin === "Finance/IMG_1.jpg" ? `![[${current}]]\n\nBS` : null),
    );
    expect(checked[1].error).toBeNull();
    expect(checked[1].target).toBe("Finance/Images/S01 — transcription.md");
    expect(checked[1].content).toContain("![[Finance/Images/S01.jpg]]");
  });

  it("skips deselected ops so later ops see the original state", () => {
    const ops = [op("move", "Finance/TD", "Finance/Exercices"), op("move", "Finance/Exercices/TD1.pdf", "Finance/TD1.pdf")];
    expect(checkPlan(ops, state, ctx, [false, true])[1].error).toBe("source introuvable");
  });
});

describe("reconcileMap", () => {
  it("rewrites resources when ops are deselected and drops ghosts", () => {
    const state = { files: ["Finance/a.pdf", "Finance/b.pdf"], folders: ["Finance"] };
    const ops = [op("move", "Finance/a.pdf", "Finance/01/a.pdf"), op("move", "Finance/b.pdf", "Finance/01/b.pdf")];
    const checked = checkPlan(ops, state, ctx);
    const m = map([
      mod("m01", {
        resources: [
          { path: "Finance/01/a.pdf", role: "cours", label: "A" },
          { path: "Finance/01/b.pdf", role: "cours", label: "B" },
          { path: "Finance/ghost.pdf", role: "cours", label: "G" },
        ],
      }),
    ]);
    const r = reconcileMap(m, checked, state, [true, false]);
    expect(r.map.modules[0].resources.map((x) => x.path)).toEqual(["Finance/01/a.pdf", "Finance/b.pdf"]);
    expect(r.dropped).toEqual(["Finance/ghost.pdf"]);
  });

  it("follows renames", () => {
    const m = map([mod("m01", { folder: "Finance/TD", resources: [{ path: "Finance/TD/x.pdf", role: "exercices", label: "x" }] })]);
    const r = renameInMap(m, "Finance/TD", "Finance/Exercices");
    expect(r.modules[0].folder).toBe("Finance/Exercices");
    expect(r.modules[0].resources[0].path).toBe("Finance/Exercices/x.pdf");
  });
});

describe("canvas", () => {
  const m = map([
    mod("m01", { resources: [{ path: "Finance/a.pdf", role: "cours", label: "Slides" }] }),
    mod("m02", { prerequisites: ["m01"], children: [mod("m02-1")] }),
    mod("m03", { prerequisites: ["m01", "m02"] }),
  ]);

  it("bands modules by prerequisite level and ignores cycles", () => {
    expect(Object.fromEntries(levels(m.modules))).toEqual({ m01: 0, m02: 1, m03: 2 });
    expect(levels([mod("a", { prerequisites: ["b"] }), mod("b", { prerequisites: ["a"] })]).size).toBe(2);
  });

  it("builds nodes and prerequisite edges with wikilinks", () => {
    const c = buildCanvas(m, { index: "Finance/Finance — Index.md" });
    expect(c.nodes.map((n) => n.id)).toContain("cc-m-m02-1");
    expect(c.edges.map((e) => e.id)).toEqual(["cc-e-m01--m02", "cc-e-m01--m03", "cc-e-m02--m03", "cc-e-course--m01"]);
    expect(c.nodes.find((n) => n.id === "cc-m-m01")!.text).toContain("[[Finance/a.pdf|Slides]]");
    const m2 = c.nodes.find((n) => n.id === "cc-m-m02")!;
    const m3 = c.nodes.find((n) => n.id === "cc-m-m03")!;
    expect(m3.y).toBeGreaterThan(m2.y);
  });

  it("keeps user positions, colours and hand-made nodes on regeneration", () => {
    const first = buildCanvas(m, { index: "i.md" });
    const node = first.nodes.find((n) => n.id === "cc-m-m01")!;
    node.x = 9999;
    node.color = "4";
    first.nodes.push({ id: "mine", type: "text", x: 0, y: 0, width: 10, height: 10, text: "perso" });
    first.edges.push({ id: "my-edge", fromNode: "mine", toNode: "cc-m-m01" });
    const second = buildCanvas(m, { index: "i.md" }, first);
    expect(second.nodes.find((n) => n.id === "cc-m-m01")!.x).toBe(9999);
    expect(readStatuses(second).get("m01")).toBe("done");
    expect(second.nodes.some((n) => n.id === "mine")).toBe(true);
    expect(second.edges.some((e) => e.id === "my-edge")).toBe(true);
    const reset = buildCanvas(m, { index: "i.md" }, first, { keepLayout: false });
    expect(reset.nodes.find((n) => n.id === "cc-m-m01")!.x).not.toBe(9999);
    expect(readStatuses(reset).get("m01")).toBe("done");
  });
});

describe("index note", () => {
  it("only replaces the generated block", () => {
    const first = mergeIndex(null, "A", "Finance");
    expect(first).toContain(`${START}\nA\n${END}`);
    const edited = first.replace(END, `${END}\n\nMes remarques`);
    const second = mergeIndex(edited, "B", "Finance");
    expect(second).toContain("Mes remarques");
    expect(second).toContain(`${START}\nB\n${END}`);
    expect(second).not.toContain("\nA\n");
  });
});

describe("applyPatch", () => {
  it("adds modules, assigns resources, never removes", () => {
    const m = map([mod("m01", { resources: [{ path: "Finance/a.pdf", role: "cours", label: "A" }] })]);
    const next = applyPatch(m, {
      newModules: [
        { id: "m01", title: "Doublon", summary: "", concepts: ["Duration"], prerequisites: [], parentId: null, folder: null },
        { id: "m02", title: "Nouveau", summary: "", concepts: [], prerequisites: ["m01"], parentId: null, folder: null },
      ],
      assignments: [
        { path: "Finance/b.pdf", moduleId: "m02", role: "exercices", label: "B" },
        { path: "Finance/a.pdf", moduleId: "m02", role: "cours", label: "A" },
        { path: "Finance/d.pdf", moduleId: null, role: "annale", label: "D" },
        { path: "Finance/e.pdf", moduleId: "unknown", role: "autre", label: "E" },
      ],
      conceptUpdates: [{ moduleId: "m01", concepts: ["VaR"] }],
    });
    expect(next.modules.map((x) => x.id)).toEqual(["m01", "m02"]);
    expect(next.modules[1].prerequisites).toEqual(["m01"]);
    // a.pdf is re-assigned, not duplicated.
    expect(next.modules[0].resources).toEqual([]);
    expect(next.modules[1].resources.map((r) => r.path)).toEqual(["Finance/b.pdf", "Finance/a.pdf"]);
    expect(next.transverse.map((r) => r.path)).toEqual(["Finance/d.pdf", "Finance/e.pdf"]);
    expect(next.modules[0].concepts.sort()).toEqual(["Duration", "VaR"]);
  });
});
