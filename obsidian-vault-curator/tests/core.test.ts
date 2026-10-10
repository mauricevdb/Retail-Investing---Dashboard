import { describe, expect, it } from "vitest";
import { buildCanvas, levels, readStatuses } from "../src/core/canvas";
import { END, mergeIndex, renderIndexBody, START } from "../src/core/indexNote";
import { applyPatch, upgradeMap } from "../src/core/mapMerge";
import { sanitizePath, uniquePath } from "../src/core/paths";
import { checkPlan, PlanContext, reconcileMap, renameInMap } from "../src/core/plan";
import { candidateFolders, scanVault } from "../src/core/scan";
import { DEFAULT_SETTINGS, migrateSettings, newSpace } from "../src/core/settings";
import { PlanOp, SectionNode, SpaceMap } from "../src/core/types";

const f = (path: string) => ({ path, size: 1000, mtime: 1 });
const op = (kind: PlanOp["kind"], source: string | null, target: string | null, content: string | null = null): PlanOp => ({ kind, source, target, content, reason: "test" });
const sec = (id: string, extra: Partial<SectionNode> = {}): SectionNode => ({
  id,
  title: id,
  summary: "",
  keywords: [],
  dependsOn: [],
  folder: null,
  resources: [],
  children: [],
  ...extra,
});
const map = (sections: SectionNode[], extra: Partial<SpaceMap> = {}): SpaceMap => ({
  version: 2,
  name: "Finance",
  folder: "Finance",
  kind: "cours",
  summary: "",
  purpose: "",
  usage: "",
  conventions: "",
  preferences: [],
  dashboardTitle: "Skill tree",
  linkKind: "prerequisite",
  sections,
  transverse: [],
  keptDashboards: [],
  updatedAt: "2026-10-10T00:00:00Z",
  ...extra,
});

const ctx: PlanContext = {
  spaceFolder: "Finance",
  inboxFolder: "📥 Inbox",
  archiveFolder: "99 Archive",
  protectedPaths: ["Finance/Finance — Dashboard.canvas", "Finance/Finance — Index.md"],
  lockedFolders: ["Finance/Projet"],
};

describe("paths", () => {
  it("sanitises and de-duplicates", () => {
    expect(sanitizePath("/Finance/../TD: 1?.pdf")).toBe("Finance/TD 1 .pdf");
    expect(uniquePath("a/b.md", (p) => p === "a/b.md" || p === "a/b (2).md")).toBe("a/b (3).md");
  });
});

describe("scanVault", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    spaces: [newSpace(DEFAULT_SETTINGS, "Master", "Vault"), newSpace(DEFAULT_SETTINGS, "Master/Finance", "Vault"), newSpace(DEFAULT_SETTINGS, "Perso", "Vault")],
  };
  const files = [
    f("Master/Plan du master.md"),
    f("Master/Finance/Cours 1.pdf"),
    f("Master/Finance/Finance — Dashboard.canvas"),
    f("Master/Finance/_curator.json"),
    f("Master/Templates/t.md"),
    f("Perso/Banque/releve.pdf"),
    f("Perso/99 Archive/old.pdf"),
    f("Perso/Dashboard.md"),
    f("📥 Inbox/scan.pdf"),
    f("Autre/x.md"),
  ];
  const folders = ["Master", "Master/Finance", "Master/Templates", "Perso", "Perso/Banque", "Perso/99 Archive", "📥 Inbox", "Autre", "Templates"];

  it("excludes nested managed folders, ignored folders, archive and the plugin's files", () => {
    const scan = scanVault(files, folders, settings, "Vault");
    const [master, finance, perso] = scan.spaces;
    expect(master.files.map((x) => x.path)).toEqual(["Master/Plan du master.md"]);
    expect(master.subspaces.map((s) => s.folder)).toEqual(["Master/Finance"]);
    expect(master.folders).toEqual([]);
    expect(finance.files.map((x) => x.path)).toEqual(["Master/Finance/Cours 1.pdf"]);
    expect(finance.hasMap).toBe(true);
    expect(perso.files.map((x) => x.path)).toEqual(["Perso/Banque/releve.pdf", "Perso/Dashboard.md"]);
    expect(perso.dashboards).toEqual(["Perso/Dashboard.md"]);
    expect(perso.structure.kinds).toEqual({ pdf: 1, markdown: 1 });
    expect(scan.inbox.map((x) => x.path)).toEqual(["📥 Inbox/scan.pdf"]);
  });

  it("can manage the whole vault and suggests unmanaged folders", () => {
    const root = { ...DEFAULT_SETTINGS, spaces: [newSpace(DEFAULT_SETTINGS, "", "Mon vault")] };
    const scan = scanVault(files, folders, root, "Mon vault");
    expect(scan.spaces[0].name).toBe("Mon vault");
    expect(scan.spaces[0].generated.canvas).toBe("Mon vault — Dashboard.canvas");
    expect(scan.spaces[0].files.some((x) => x.path === "📥 Inbox/scan.pdf")).toBe(false);
    expect(candidateFolders(folders, settings)).toEqual(["Autre"]);
  });
});

describe("checkPlan", () => {
  const state = {
    files: ["Finance/IMG_1.jpg", "Finance/TD/TD1.pdf", "Finance/TD/TD2.pdf", "Finance/notes.md", "Finance/Projet/a.md", "📥 Inbox/x.pdf"],
    folders: ["Finance", "Finance/TD", "Finance/Projet", "📥 Inbox"],
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
        op("move", "Finance/notes.md", "Autre/notes.md"),
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
      null, // a folder-relative path is resolved inside the managed folder
    ]);
    expect(checked[5].target).toBe("Finance/Autre/notes.md");
  });

  it("never enters a nested managed folder, but may move it whole", () => {
    const checked = checkPlan(
      [op("move", "Finance/Projet/a.md", "Finance/a.md"), op("move", "Finance/notes.md", "Finance/Projet/notes.md"), op("move", "Finance/Projet", "Finance/02 Projet")],
      state,
      ctx,
    );
    expect(checked.map((c) => c.error)).toEqual(["dans un sous-espace géré à part", "dans un sous-espace géré à part", null]);
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

  it("fills transcriptions from the source's original path", () => {
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
      sec("s01", {
        resources: [
          { path: "Finance/01/a.pdf", role: "cours", label: "A" },
          { path: "Finance/01/b.pdf", role: "cours", label: "B" },
          { path: "Finance/ghost.pdf", role: "cours", label: "G" },
        ],
      }),
    ]);
    const r = reconcileMap(m, checked, state, [true, false]);
    expect(r.map.sections[0].resources.map((x) => x.path)).toEqual(["Finance/01/a.pdf", "Finance/b.pdf"]);
    expect(r.dropped).toEqual(["Finance/ghost.pdf"]);
  });

  it("follows renames", () => {
    const m = map([sec("s01", { folder: "Finance/TD", resources: [{ path: "Finance/TD/x.pdf", role: "exercices", label: "x" }] })]);
    const r = renameInMap(m, "Finance/TD", "Finance/Exercices");
    expect(r.sections[0].folder).toBe("Finance/Exercices");
    expect(r.sections[0].resources[0].path).toBe("Finance/Exercices/x.pdf");
  });
});

describe("canvas", () => {
  const m = map([
    sec("s01", { resources: [{ path: "Finance/a.pdf", role: "cours", label: "Slides" }] }),
    sec("s02", { dependsOn: ["s01"], children: [sec("s02-1")] }),
    sec("s03", { dependsOn: ["s01", "s02"] }),
  ]);

  it("bands sections by dependency level and ignores cycles", () => {
    expect(Object.fromEntries(levels(m.sections))).toEqual({ s01: 0, s02: 1, s03: 2 });
    expect(levels([sec("a", { dependsOn: ["b"] }), sec("b", { dependsOn: ["a"] })]).size).toBe(2);
  });

  it("builds nodes, dependency arrows, wikilinks and sub-folder links", () => {
    const c = buildCanvas(m, { index: "Finance/Finance — Index.md", subspaces: [{ name: "Projet", canvas: "Finance/Projet/Projet — Dashboard.canvas" }] });
    expect(c.nodes.map((n) => n.id)).toContain("cc-m-s02-1");
    expect(c.edges.map((e) => e.id)).toEqual(["cc-e-s01--s02", "cc-e-s01--s03", "cc-e-s02--s03", "cc-e-course--s01"]);
    expect(c.nodes.find((n) => n.id === "cc-m-s01")!.text).toContain("[[Finance/a.pdf|Slides]]");
    expect(c.nodes.find((n) => n.id === "cc-course")!.text).toContain("# Finance — Skill tree");
    expect(c.nodes.find((n) => n.id === "cc-subspaces")!.text).toContain("[[Finance/Projet/Projet — Dashboard.canvas|Projet]]");
    expect(c.nodes.find((n) => n.id === "cc-m-s03")!.y).toBeGreaterThan(c.nodes.find((n) => n.id === "cc-m-s02")!.y);
  });

  it("lays independent categories on a grid without arrows", () => {
    const c = buildCanvas({ ...m, linkKind: "none" }, { index: "i.md" });
    expect(c.edges).toEqual([]);
    const ys = new Set(["s01", "s02", "s03"].map((id) => c.nodes.find((n) => n.id === `cc-m-${id}`)!.y));
    expect(ys.size).toBe(1);
  });

  it("keeps user positions, colours and hand-made nodes on regeneration", () => {
    const first = buildCanvas(m, { index: "i.md" });
    const node = first.nodes.find((n) => n.id === "cc-m-s01")!;
    node.x = 9999;
    node.color = "4";
    first.nodes.push({ id: "mine", type: "text", x: 0, y: 0, width: 10, height: 10, text: "perso" });
    first.edges.push({ id: "my-edge", fromNode: "mine", toNode: "cc-m-s01" });
    const second = buildCanvas(m, { index: "i.md" }, first);
    expect(second.nodes.find((n) => n.id === "cc-m-s01")!.x).toBe(9999);
    expect(readStatuses(second).get("s01")).toBe("done");
    expect(second.nodes.some((n) => n.id === "mine")).toBe(true);
    expect(second.edges.some((e) => e.id === "my-edge")).toBe(true);
    const reset = buildCanvas(m, { index: "i.md" }, first, { keepLayout: false });
    expect(reset.nodes.find((n) => n.id === "cc-m-s01")!.x).not.toBe(9999);
    expect(readStatuses(reset).get("s01")).toBe("done");
  });
});

describe("canvas newcomers", () => {
  it("puts new sections below the kept layout and new sub-sections inside their group", () => {
    const base = map([sec("a"), sec("b"), sec("c")], { linkKind: "none" });
    const first = buildCanvas(base, { index: "i.md" });
    const grown = map([sec("a", { children: [sec("a-1")] }), sec("b"), sec("c"), sec("d")], { linkKind: "none" });
    const second = buildCanvas(grown, { index: "i.md" }, first);
    const get = (id: string) => second.nodes.find((n) => n.id === id)!;
    const overlap = (p: { x: number; y: number; width: number; height: number }, q: typeof p) =>
      p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    for (const g of ["cc-g-a", "cc-g-b", "cc-g-c"]) expect(overlap(get("cc-g-d"), get(g))).toBe(false);
    expect(get("cc-g-d").y).toBeGreaterThan(get("cc-g-a").y + get("cc-g-a").height);
    const child = get("cc-m-a-1");
    const group = get("cc-g-a");
    expect(child.y).toBeGreaterThan(get("cc-m-a").y + get("cc-m-a").height);
    expect(child.y + child.height).toBeLessThanOrEqual(group.y + group.height);
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

  it("carries the folder's user manual", () => {
    const body = renderIndexBody(map([], { purpose: "Réviser", usage: "Avant chaque partiel", conventions: "Un dossier par module", preferences: ["Classer par date"] }), "Finance/d.canvas", []);
    expect(body).toContain("> [!info]- Mode d'emploi");
    expect(body).toContain("> **À quoi sert ce dossier** — Réviser");
    expect(body).toContain("> - Classer par date");
  });
});

describe("applyPatch", () => {
  it("adds sections, assigns resources, never removes", () => {
    const m = map([sec("s01", { resources: [{ path: "Finance/a.pdf", role: "cours", label: "A" }] })]);
    const next = applyPatch(m, {
      newSections: [
        { id: "s01", title: "Doublon", summary: "", keywords: ["Duration"], dependsOn: [], parentId: null, folder: null },
        { id: "s02", title: "Nouveau", summary: "", keywords: [], dependsOn: ["s01"], parentId: null, folder: null },
      ],
      assignments: [
        { path: "Finance/b.pdf", sectionId: "s02", role: "exercices", label: "B" },
        { path: "Finance/a.pdf", sectionId: "s02", role: "cours", label: "A" },
        { path: "Finance/d.pdf", sectionId: null, role: "planning", label: "D" },
        { path: "Finance/e.pdf", sectionId: "unknown", role: "autre", label: "E" },
      ],
      keywordUpdates: [{ sectionId: "s01", keywords: ["VaR"] }],
    });
    expect(next.sections.map((x) => x.id)).toEqual(["s01", "s02"]);
    expect(next.sections[1].dependsOn).toEqual(["s01"]);
    expect(next.sections[0].resources).toEqual([]);
    expect(next.sections[1].resources.map((r) => r.path)).toEqual(["Finance/b.pdf", "Finance/a.pdf"]);
    expect(next.transverse.map((r) => r.path)).toEqual(["Finance/d.pdf", "Finance/e.pdf"]);
    expect(next.sections[0].keywords.sort()).toEqual(["Duration", "VaR"]);
  });
});

describe("version 0.1 compatibility", () => {
  it("upgrades a course map", () => {
    const v1 = {
      version: 1,
      course: "Taux",
      folder: "Taux",
      summary: "S",
      modules: [{ id: "m01", title: "Intro", summary: "", concepts: ["VA"], prerequisites: [], folder: null, resources: [{ path: "Taux/a.jpg", role: "tableau", label: "T" }], children: [], status: "done" }],
      transverse: [{ path: "Taux/s.pdf", role: "syllabus", label: "Syllabus" }],
      keptDashboards: [],
      updatedAt: "2026-10-01T00:00:00Z",
    };
    const m = upgradeMap(v1)!;
    expect(m.version).toBe(2);
    expect(m.sections[0]).toMatchObject({ id: "m01", keywords: ["VA"], dependsOn: [], status: "done" });
    expect(m.sections[0].resources[0].role).toBe("manuscrit");
    expect(m.transverse[0].role).toBe("planning");
    expect(m.linkKind).toBe("prerequisite");
  });

  it("turns organised courses into managed folders, keeping their dashboard names", () => {
    const s = migrateSettings({ coursesRoot: "", transcribePhotos: false, canvasName: "{course} — Skill tree" }, (f) => f === "Taux", ["Taux", "Stats", "Taux/TD"]);
    expect(s.spaces.map((x) => [x.folder, x.canvas])).toEqual([["Taux", "Taux/Taux — Skill tree.canvas"]]);
    expect(s.transcribeHandwriting).toBe(false);
    expect(s.canvasName).toBe("{name} — Dashboard");
    expect("coursesRoot" in s).toBe(false);
  });
});
