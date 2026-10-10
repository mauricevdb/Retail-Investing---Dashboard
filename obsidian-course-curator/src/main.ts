import { debounce, FileSystemAdapter, FuzzySuggestModal, Notice, Platform, Plugin, TAbstractFile, TFile } from "obsidian";
import { VaultScan } from "./core/scan";
import { CuratorSettings, DEFAULT_SETTINGS } from "./core/settings";
import { Engine, PluginData, PreparedPlan, Progress } from "./engine";
import { AnthropicApiBackend } from "./llm/anthropicApi";
import { ClaudeCodeBackend } from "./llm/claudeCode";
import { LlmBackend } from "./llm/types";
import { ObsidianIO } from "./obsidianIO";
import { CuratorView, VIEW_TYPE } from "./ui/CuratorView";
import { PlanModal } from "./ui/PlanModal";
import { CuratorSettingTab } from "./ui/SettingsTab";

interface Task {
  message: string;
  done?: number;
  total?: number;
  controller: AbortController;
}

export default class CourseCuratorPlugin extends Plugin {
  data!: PluginData;
  engine!: Engine;
  task: Task | null = null;
  private claudeCode: ClaudeCodeBackend | null = null;
  private api!: AnthropicApiBackend;
  private statusEl!: HTMLElement;
  private lastNewCount = 0;

  get cfg(): CuratorSettings {
    return this.data.settings;
  }

  async onload() {
    const saved = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) },
      ledger: saved.ledger ?? {},
      journal: saved.journal ?? [],
    };

    const adapter = this.app.vault.adapter;
    if (Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
      this.claudeCode = new ClaudeCodeBackend(adapter.getBasePath(), () => this.cfg);
    }
    this.api = new AnthropicApiBackend(() => this.cfg);
    const store = { data: this.data, save: () => this.saveData(this.data) };
    this.engine = new Engine(new ObsidianIO(this.app, this), () => this.backend(), store);

    this.registerView(VIEW_TYPE, (leaf) => new CuratorView(leaf, this));
    this.addSettingTab(new CuratorSettingTab(this.app, this));
    this.addRibbonIcon("graduation-cap", "Course Curator", () => void this.openView());
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onclick = () => void this.openView();

    this.addCommand({ id: "open-panel", name: "Ouvrir le panneau", callback: () => void this.openView() });
    this.addCommand({
      id: "onboard-all",
      name: "Organiser tous les cours pas encore organisés",
      callback: () => void this.onboard(this.engine.scan().courses.filter((c) => !c.hasMap).map((c) => c.folder)),
    });
    this.addCommand({ id: "onboard-course", name: "Organiser / réorganiser un cours…", callback: () => this.pickCourse((f) => void this.onboard([f])) });
    this.addCommand({ id: "aggregate", name: "Agréger les nouveaux documents", callback: () => void this.aggregate() });
    this.addCommand({ id: "refresh-dashboards", name: "Régénérer les skill trees et index (sans Claude)", callback: () => void this.refreshAll(true) });
    this.addCommand({ id: "reset-layout", name: "Réinitialiser la mise en page d'un skill tree…", callback: () => this.pickCourse((f) => void this.refreshOne(f, false), true) });
    this.addCommand({ id: "undo", name: "Annuler la dernière opération", callback: () => void this.undo() });
    this.addCommand({
      id: "test-connection",
      name: "Tester la connexion à Claude",
      callback: async () => {
        const error = await this.backend().check();
        new Notice(error ? `Course Curator : ${error}` : `Course Curator : ${this.backend().name} répond.`);
      },
    });

    // Keep maps and dashboards in sync when the user renames things by hand.
    const pendingRenames: [string, string][] = [];
    const flushRenames = debounce(
      async () => {
        const batch = pendingRenames.splice(0);
        const touched = new Map<string, string>();
        for (const [from, to] of batch) for (const c of await this.engine.followRename(from, to)) touched.set(c.folder, c.name);
        for (const folder of touched.keys()) await this.refreshOne(folder, true, true);
      },
      1500,
      true,
    );
    this.engine.onMapRenamed((from, to) => {
      pendingRenames.push([from, to]);
      flushRenames();
    });

    const recount = debounce(() => this.updateStatus(true), 4000, true);
    this.app.workspace.onLayoutReady(() => {
      this.updateStatus(false);
      this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && recount()));
      this.registerEvent(this.app.vault.on("delete", (f) => this.forget(f)));
      const scan = this.engine.scan();
      if (scan.courses.length && scan.courses.every((c) => !c.hasMap) && !Object.keys(this.data.ledger).length) {
        const n = new Notice(`Course Curator : ${scan.courses.length} cours détectés. Cliquez ici pour lancer le premier rangement.`, 15000);
        n.noticeEl.onclick = () => void this.openView();
      }
    });
  }

  async onunload() {
    this.task?.controller.abort();
  }

  async saveSettings() {
    this.claudeCode?.reset();
    await this.saveData(this.data);
    this.refreshView();
  }

  backend(): LlmBackend {
    if (this.cfg.backend === "claude-code") {
      if (!this.claudeCode) throw new Error("Claude Code n'est disponible que sur ordinateur : choisissez l'API Claude dans les réglages.");
      return this.claudeCode;
    }
    return this.api;
  }

  // -------------------------------------------------------------------------
  // Workflows

  /** First (or new) organisation of the given courses, one reviewed plan at a time. */
  async onboard(folders: string[]) {
    if (!folders.length) return new Notice("Tous les cours sont déjà organisés.");
    await this.run("Organisation", async (progress, signal) => {
      for (const [i, folder] of folders.entries()) {
        const course = this.engine.course(folder);
        if (!course) continue;
        const prepared = await this.engine.planOnboarding(course, prefix(progress, course.name), signal);
        const go = await this.review(prepared, `(${i + 1}/${folders.length})`, progress);
        if (go === "stop") break;
      }
    });
  }

  /** Routes the inbox, then proposes how to aggregate new documents in each organised course. */
  async aggregate(only?: string[]) {
    await this.run("Agrégation", async (progress, signal) => {
      const scan = this.engine.scan();
      const extra = new Map<string, TFileLike[]>();
      if (!only && scan.inbox.length) {
        const { routed, unrouted } = await this.engine.routeInbox(scan, progress, signal);
        for (const [folder, files] of routed) extra.set(folder, files);
        if (unrouted.length) new Notice(`${unrouted.length} document(s) de la boîte de réception n'ont pas pu être attribués à un cours.`);
      }
      const work = scan.courses
        .filter((c) => !only || only.includes(c.folder))
        .map((c) => ({ course: c, files: [...this.engine.newFiles(c), ...(extra.get(c.folder) ?? [])] }))
        .filter((w) => w.files.length);
      const notOrganised = work.filter((w) => !w.course.hasMap);
      if (notOrganised.length) {
        new Notice(`À organiser d'abord : ${notOrganised.map((w) => w.course.name).join(", ")}.`);
      }
      const ready = work.filter((w) => w.course.hasMap);
      if (!ready.length) {
        new Notice("Aucun nouveau document à agréger.");
        return;
      }
      for (const [i, { course, files }] of ready.entries()) {
        const prepared = await this.engine.planIncremental(course, files, prefix(progress, course.name), signal);
        const go = await this.review(prepared, `(${i + 1}/${ready.length})`, progress);
        if (go === "stop") break;
      }
    });
  }

  private async review(prepared: PreparedPlan, position: string, progress: Progress): Promise<"done" | "skip" | "stop"> {
    progress(`En attente de validation : ${prepared.course.name}`);
    const result = await new PlanModal(this.app, this.engine, prepared, position).review();
    if (result.action !== "apply") return result.action;
    const report = await this.engine.apply(prepared, result.selected, prefix(progress, prepared.course.name));
    const lines = [`${prepared.course.name} : ${report.applied} opération(s) appliquée(s).`];
    if (report.failed.length) lines.push(`${report.failed.length} échec(s) : ${report.failed.map((f) => f.error).join(" ; ")}`);
    if (report.dropped.length) lines.push(`${report.dropped.length} référence(s) introuvable(s) retirée(s) du skill tree.`);
    const n = new Notice(`${lines.join("\n")}\nCliquez pour ouvrir le skill tree.`, 10000);
    n.noticeEl.onclick = () => void this.openFile(report.canvas);
    return "done";
  }

  async undo() {
    await this.run("Annulation", async () => {
      const r = await this.engine.undoLast();
      if (!r) return void new Notice("Rien à annuler.");
      new Notice(`Annulé : ${r.label}${r.warnings.length ? `\n${r.warnings.length} avertissement(s) : ${r.warnings.slice(0, 3).join(" ; ")}` : ""}`, 10000);
    });
  }

  private async refreshAll(keepLayout: boolean) {
    let n = 0;
    for (const course of this.engine.scan().courses) if (await this.engine.refreshDashboards(course, keepLayout)) n++;
    new Notice(`${n} skill tree(s) régénéré(s).`);
  }

  private async refreshOne(folder: string, keepLayout: boolean, quiet = false) {
    const course = this.engine.course(folder);
    if (!course || !(await this.engine.refreshDashboards(course, keepLayout))) {
      if (!quiet) new Notice("Ce cours n'a pas encore de skill tree : organisez-le d'abord.");
      return;
    }
    if (!quiet) new Notice(`Skill tree de ${course.name} régénéré.`);
  }

  /** Runs one workflow at a time, with progress in the panel and cancellation. */
  private async run(label: string, fn: (progress: Progress, signal: AbortSignal) => Promise<void>) {
    if (this.task) return void new Notice("Course Curator travaille déjà ; patientez ou annulez la tâche en cours.");
    const controller = new AbortController();
    this.task = { message: `${label}…`, controller };
    this.refreshView();
    const progress: Progress = (message, done, total) => {
      if (!this.task) return;
      this.task.message = message;
      this.task.done = done;
      this.task.total = total;
      this.refreshView();
    };
    try {
      await fn(progress, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) {
        console.error("Course Curator", e);
        new Notice(`Course Curator : ${(e as Error).message}`, 12000);
      } else new Notice("Course Curator : tâche annulée.");
    } finally {
      this.task = null;
      this.updateStatus(false);
      this.refreshView();
    }
  }

  cancelTask() {
    this.task?.controller.abort();
  }

  // -------------------------------------------------------------------------
  // UI helpers

  countNew(scan: VaultScan = this.engine.scan()): number {
    return scan.courses.filter((c) => c.hasMap).reduce((n, c) => n + this.engine.newFiles(c).length, 0) + scan.inbox.length;
  }

  private updateStatus(notify: boolean) {
    const scan = this.engine.scan();
    const n = this.countNew(scan);
    this.statusEl.setText(n ? `🎓 ${n} nouveau(x) doc(s)` : "");
    if (notify && this.cfg.watchNewFiles && n > this.lastNewCount && !this.task) {
      const notice = new Notice(`Course Curator : ${n} nouveau(x) document(s) à agréger. Cliquez pour voir.`, 8000);
      notice.noticeEl.onclick = () => void this.openView();
    }
    this.lastNewCount = n;
    this.refreshView();
  }

  private forget(f: TAbstractFile) {
    for (const key of Object.keys(this.data.ledger)) if (key === f.path || key.startsWith(`${f.path}/`)) delete this.data.ledger[key];
    void this.saveData(this.data);
    this.updateStatus(false);
  }

  private refreshView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof CuratorView) void leaf.view.render();
    }
  }

  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async openFile(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
    else new Notice(`${path} introuvable.`);
  }

  private pickCourse(onPick: (folder: string) => void, organisedOnly = false) {
    const courses = this.engine.scan().courses.filter((c) => !organisedOnly || c.hasMap);
    new CoursePicker(this, courses.map((c) => ({ folder: c.folder, name: c.name, organised: c.hasMap })), onPick).open();
  }
}

type TFileLike = { path: string; size: number; mtime: number };

function prefix(progress: Progress, course: string): Progress {
  return (message, done, total) => progress(`${course} — ${message}`, done, total);
}

class CoursePicker extends FuzzySuggestModal<{ folder: string; name: string; organised: boolean }> {
  constructor(
    plugin: CourseCuratorPlugin,
    private readonly courses: { folder: string; name: string; organised: boolean }[],
    private readonly onPick: (folder: string) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder("Choisir un cours");
  }
  getItems() {
    return this.courses;
  }
  getItemText(item: { name: string; organised: boolean }) {
    return `${item.name}${item.organised ? "" : "  (pas encore organisé)"}`;
  }
  onChooseItem(item: { folder: string }) {
    this.onPick(item.folder);
  }
}
