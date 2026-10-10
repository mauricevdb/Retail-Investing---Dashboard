import { debounce, FileSystemAdapter, Menu, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { candidateFolders, VaultScan } from "./core/scan";
import { CuratorSettings, DEFAULT_SETTINGS, mapPath, migrateSettings } from "./core/settings";
import { Feedback } from "./core/types";
import { Engine, PluginData, PreparedPlan, Progress } from "./engine";
import { AnthropicApiBackend } from "./llm/anthropicApi";
import { ClaudeCodeBackend } from "./llm/claudeCode";
import { LlmBackend } from "./llm/types";
import { ObsidianIO } from "./obsidianIO";
import { CuratorView, VIEW_TYPE } from "./ui/CuratorView";
import { PlanModal } from "./ui/PlanModal";
import { CuratorSettingTab } from "./ui/SettingsTab";
import { AddSpaceModal, FolderPicker } from "./ui/SpaceModals";

interface Task {
  message: string;
  done?: number;
  total?: number;
  controller: AbortController;
}

export default class VaultCuratorPlugin extends Plugin {
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
    const saved = ((await this.loadData()) ?? {}) as Partial<PluginData> & { settings?: Record<string, unknown> };
    const rawSettings = (saved.settings ?? {}) as Record<string, unknown>;
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...rawSettings, spaces: Array.isArray(rawSettings.spaces) ? (rawSettings.spaces as CuratorSettings["spaces"]) : [] },
      ledger: saved.ledger ?? {},
      journal: saved.journal ?? [],
    };

    const adapter = this.app.vault.adapter;
    if (Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
      this.claudeCode = new ClaudeCodeBackend(adapter.getBasePath(), () => this.cfg);
    }
    this.api = new AnthropicApiBackend(() => this.cfg);
    const store = { data: this.data, save: () => this.saveData(this.data) };
    this.engine = new Engine(new ObsidianIO(this.app, this), () => this.backend(), store, this.app.vault.getName());

    this.registerView(VIEW_TYPE, (leaf) => new CuratorView(leaf, this));
    this.addSettingTab(new CuratorSettingTab(this.app, this));
    this.addRibbonIcon("sparkles", "Vault Curator", () => void this.openView());
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onclick = () => void this.openView();

    this.addCommand({ id: "open-panel", name: "Ouvrir le panneau", callback: () => void this.openView() });
    this.addCommand({ id: "add-folder", name: "Organiser un dossier…", callback: () => this.pickFolderToAdd() });
    this.addCommand({ id: "organise", name: "Réorganiser un dossier géré…", callback: () => this.pickSpace((f) => void this.organise([f])) });
    this.addCommand({ id: "aggregate", name: "Agréger les nouveaux documents", callback: () => void this.aggregate() });
    this.addCommand({ id: "refresh-dashboards", name: "Régénérer les dashboards (sans Claude)", callback: () => void this.refreshAll(true) });
    this.addCommand({ id: "reset-layout", name: "Réinitialiser la mise en page d'un dashboard…", callback: () => this.pickSpace((f) => void this.refreshOne(f, false), true) });
    this.addCommand({ id: "undo", name: "Annuler la dernière opération", callback: () => void this.undo() });
    this.addCommand({
      id: "test-connection",
      name: "Tester la connexion à Claude",
      callback: async () => {
        const error = await this.backend().check();
        new Notice(error ? `Vault Curator : ${error}` : `Vault Curator : ${this.backend().name} répond.`);
      },
    });

    // Right-click on a folder in the file explorer.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) return;
        const folder = file.isRoot() ? "" : file.path;
        const managed = this.cfg.spaces.some((s) => s.folder === folder);
        menu.addItem((item) =>
          item
            .setTitle(managed ? "Vault Curator : réorganiser ce dossier" : "Vault Curator : organiser ce dossier")
            .setIcon("sparkles")
            .onClick(() => (managed ? void this.organise([folder]) : void this.addFolder(folder))),
        );
        if (managed) {
          menu.addItem((item) =>
            item
              .setTitle("Vault Curator : agréger les nouveaux documents")
              .setIcon("inbox")
              .onClick(() => void this.aggregate([folder])),
          );
        }
      }),
    );

    // Keep maps and dashboards in sync when the user renames things by hand.
    const pendingRenames: [string, string][] = [];
    const flushRenames = debounce(
      async () => {
        const batch = pendingRenames.splice(0);
        const touched = new Set<string>();
        for (const [from, to] of batch) for (const c of await this.engine.followRename(from, to)) touched.add(c.folder);
        for (const folder of touched) await this.refreshOne(folder, true, true);
        this.refreshView();
      },
      1500,
      true,
    );
    this.engine.onMapRenamed((from, to) => {
      pendingRenames.push([from, to]);
      flushRenames();
    });

    const recount = debounce(() => this.updateStatus(true), 4000, true);
    this.app.workspace.onLayoutReady(async () => {
      await this.migrate(rawSettings);
      this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && recount()));
      this.registerEvent(this.app.vault.on("delete", (f) => this.forget(f)));
      this.onStart();
    });
  }

  async onunload() {
    this.task?.controller.abort();
  }

  /** Version 0.1 managed courses only: turn them into managed folders. */
  private async migrate(raw: Record<string, unknown>) {
    if (Array.isArray(raw.spaces) || !("coursesRoot" in raw)) return;
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
      .map((f) => f.path);
    this.data.settings = migrateSettings(raw, (folder) => this.app.vault.getAbstractFileByPath(mapPath(folder)) !== null, folders);
    await this.saveData(this.data);
    if (this.cfg.spaces.length) new Notice(`Vault Curator : ${this.cfg.spaces.length} cours déjà organisés repris comme dossiers gérés.`);
  }

  /** On each start: look for new material in the managed folders. */
  private onStart() {
    this.updateStatus(false);
    if (!this.cfg.spaces.length) {
      const n = new Notice("Vault Curator : clique ici (ou clic droit sur un dossier) pour choisir un premier dossier à organiser.", 15000);
      n.noticeEl.onclick = () => void this.openView();
      return;
    }
    if (!this.cfg.checkOnStart) return;
    const n = this.countNew();
    if (!n) return;
    if (this.cfg.aggregateOnStart) void this.aggregate();
    else {
      const notice = new Notice(`Vault Curator : ${n} nouveau(x) document(s) depuis la dernière fois. Cliquez pour les agréger.`, 15000);
      notice.noticeEl.onclick = () => void this.aggregate();
    }
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
  // Managed folders

  pickFolderToAdd() {
    const managed = new Set(this.cfg.spaces.map((s) => s.folder));
    const folders = ["", ...this.engine.scanFolders()].filter((f) => !managed.has(f));
    new FolderPicker(this.app, folders, (f) => void this.addFolder(f), "Quel dossier organiser ?").open();
  }

  async addFolder(folder: string) {
    const choice = await new AddSpaceModal(this.app, folder).ask();
    if (!choice) return;
    const error = await this.engine.addSpace(folder, choice.instructions);
    if (error) return void new Notice(`Vault Curator : ${error}`);
    this.refreshView();
    if (choice.action === "organise") await this.organise([folder]);
  }

  async editInstructions(folder: string) {
    const space = this.cfg.spaces.find((s) => s.folder === folder);
    if (!space) return;
    const choice = await new AddSpaceModal(this.app, folder, space.instructions, true).ask();
    if (!choice) return;
    await this.engine.setInstructions(folder, choice.instructions);
    this.refreshView();
  }

  async removeSpace(folder: string) {
    await this.engine.removeSpace(folder);
    new Notice(`« ${folder || "Tout le vault"} » n'est plus géré. Ses fichiers et son dashboard restent en place.`);
    this.refreshView();
  }

  // -------------------------------------------------------------------------
  // Workflows

  /** Organises (or re-organises) folders, one discussed and validated plan at a time. */
  async organise(folders: string[]) {
    if (!folders.length) return void new Notice("Aucun dossier à organiser.");
    await this.run("Organisation", async (progress, signal) => {
      for (const [i, folder] of folders.entries()) {
        const space = this.engine.space(folder);
        if (!space) continue;
        const prepared = await this.engine.planInitial(space, prefix(progress, space.name), signal);
        const go = await this.review(prepared, `(${i + 1}/${folders.length})`, progress, signal);
        if (go === "stop") break;
      }
    });
  }

  /** Routes the inbox, then proposes how to aggregate new material in each organised folder. */
  async aggregate(only?: string[]) {
    await this.run("Agrégation", async (progress, signal) => {
      const scan = this.engine.scan();
      const extra = new Map<string, { path: string; size: number; mtime: number }[]>();
      if (!only && scan.inbox.length) {
        const { routed, unrouted } = await this.engine.routeInbox(scan, progress, signal);
        for (const [folder, files] of routed) extra.set(folder, files);
        if (unrouted.length) new Notice(`${unrouted.length} document(s) de la boîte de réception n'ont pu être attribués à aucun dossier géré.`);
      }
      const work = scan.spaces
        .filter((c) => !only || only.includes(c.folder))
        .map((c) => ({ space: c, files: [...this.engine.newFiles(c), ...(extra.get(c.folder) ?? [])] }))
        .filter((w) => w.files.length);
      const notOrganised = work.filter((w) => !w.space.hasMap);
      if (notOrganised.length) new Notice(`À organiser d'abord : ${notOrganised.map((w) => w.space.name).join(", ")}.`);
      const ready = work.filter((w) => w.space.hasMap);
      if (!ready.length) return void new Notice("Aucun nouveau document à agréger.");
      for (const [i, { space, files }] of ready.entries()) {
        const prepared = await this.engine.planIncremental(space, files, prefix(progress, space.name), signal);
        const go = await this.review(prepared, `(${i + 1}/${ready.length})`, progress, signal);
        if (go === "stop") break;
      }
    });
  }

  private async review(prepared: PreparedPlan, position: string, progress: Progress, signal: AbortSignal): Promise<"done" | "skip" | "stop"> {
    progress(`En attente de tes retours : ${prepared.space.name}`);
    const reviser = (p: PreparedPlan, feedback: Feedback, modalSignal: AbortSignal) =>
      this.engine.revise(p, feedback, prefix(progress, p.space.name), anySignal(signal, modalSignal)).finally(() => progress(`En attente de tes retours : ${p.space.name}`));
    const result = await new PlanModal(this.app, this.engine, prepared, position, reviser).review();
    if (result.action !== "apply") return result.action;
    const final = result.prepared;
    const report = await this.engine.apply(final, result.selected, prefix(progress, final.space.name));
    const lines = [`${final.space.name} : ${report.applied} opération(s) appliquée(s).`];
    if (report.failed.length) lines.push(`${report.failed.length} échec(s) : ${report.failed.map((f) => f.error).join(" ; ")}`);
    if (report.dropped.length) lines.push(`${report.dropped.length} référence(s) introuvable(s) retirée(s) du dashboard.`);
    const n = new Notice(`${lines.join("\n")}\nCliquez pour ouvrir le dashboard.`, 10000);
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
    for (const space of this.engine.scan().spaces) if (await this.engine.refreshDashboards(space, keepLayout)) n++;
    new Notice(`${n} dashboard(s) régénéré(s).`);
  }

  private async refreshOne(folder: string, keepLayout: boolean, quiet = false) {
    const space = this.engine.space(folder);
    if (!space || !(await this.engine.refreshDashboards(space, keepLayout))) {
      if (!quiet) new Notice("Ce dossier n'a pas encore de dashboard : organisez-le d'abord.");
      return;
    }
    if (!quiet) new Notice(`Dashboard de ${space.name} régénéré.`);
  }

  /** Runs one workflow at a time, with progress in the panel and cancellation. */
  private async run(label: string, fn: (progress: Progress, signal: AbortSignal) => Promise<void>) {
    if (this.task) return void new Notice("Vault Curator travaille déjà ; patientez ou annulez la tâche en cours.");
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
        console.error("Vault Curator", e);
        new Notice(`Vault Curator : ${(e as Error).message}`, 12000);
      } else new Notice("Vault Curator : tâche annulée.");
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
    return scan.spaces.filter((c) => c.hasMap).reduce((n, c) => n + this.engine.newFiles(c).length, 0) + (scan.spaces.length ? scan.inbox.length : 0);
  }

  candidates(): string[] {
    return candidateFolders(this.engine.scanFolders(), this.cfg);
  }

  private updateStatus(notify: boolean) {
    const n = this.countNew();
    this.statusEl.setText(n ? `✨ ${n} nouveau(x) doc(s)` : "");
    if (notify && this.cfg.checkOnStart && n > this.lastNewCount && !this.task) {
      const notice = new Notice(`Vault Curator : ${n} nouveau(x) document(s) à agréger. Cliquez pour voir.`, 8000);
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

  refreshView() {
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

  private pickSpace(onPick: (folder: string) => void, organisedOnly = false) {
    const spaces = this.engine.scan().spaces.filter((c) => !organisedOnly || c.hasMap);
    if (!spaces.length) return void new Notice("Aucun dossier géré pour l'instant : commencez par « Organiser un dossier… ».");
    const labels = new Map(spaces.map((s) => [s.folder, `${s.folder || "/ (tout le vault)"}${s.hasMap ? "" : "  (pas encore organisé)"}`]));
    new FolderPicker(this.app, spaces.map((s) => s.folder), onPick, "Choisir un dossier géré", labels).open();
  }
}

function prefix(progress: Progress, name: string): Progress {
  return (message, done, total) => progress(`${name} — ${message}`, done, total);
}

/** Aborts when either signal aborts. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any([a, b]);
  const c = new AbortController();
  const stop = () => c.abort();
  if (a.aborted || b.aborted) c.abort();
  a.addEventListener("abort", stop);
  b.addEventListener("abort", stop);
  return c.signal;
}
