import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type VaultCuratorPlugin from "../main";

export const VIEW_TYPE = "course-curator";

/** Side panel: the managed folders with their state and actions, plus the running task. */
export class CuratorView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultCuratorPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Vault Curator";
  }
  getIcon() {
    return "sparkles";
  }

  async onOpen() {
    await this.render();
  }

  async render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("course-curator-view");
    const { plugin } = this;
    const scan = plugin.engine.scan();

    const top = el.createDiv({ cls: "cc-view-top" });
    top.createEl("h4", { text: "Vault Curator" });
    top.createDiv({ cls: "cc-muted", text: `Claude via ${plugin.cfg.backend === "claude-code" ? "Claude Code (abonnement)" : "l'API"}` });

    const task = plugin.task;
    if (task) {
      const box = el.createDiv({ cls: "cc-task" });
      box.createDiv({ text: task.message });
      if (task.total) {
        const bar = box.createEl("progress");
        bar.max = task.total;
        bar.value = task.done ?? 0;
      }
      box.createEl("button", { text: "Annuler" }).onclick = () => plugin.cancelTask();
    }

    const busy = !!task;
    const actions = el.createDiv({ cls: "cc-actions" });
    const button = (text: string, icon: string, fn: () => void, cta = false) => {
      const b = actions.createEl("button", { cls: cta ? "mod-cta" : "" });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: ` ${text}` });
      b.disabled = busy;
      b.onclick = fn;
    };
    const newCount = plugin.countNew(scan);
    if (scan.spaces.length) {
      button(newCount ? `Agréger ${newCount} nouveau(x) document(s)` : "Chercher de nouveaux documents", "inbox", () => void plugin.aggregate(), newCount > 0);
    }
    button("Organiser un dossier…", "folder-plus", () => plugin.pickFolderToAdd(), !scan.spaces.length);
    if (plugin.data.journal.length) button(`Annuler : ${plugin.data.journal[0].label}`, "undo-2", () => void plugin.undo());

    if (scan.inbox.length) el.createDiv({ cls: "cc-inbox", text: `📥 ${scan.inbox.length} document(s) dans « ${plugin.cfg.inboxFolder} »` });

    if (scan.spaces.length) el.createEl("h5", { text: "Dossiers gérés" });
    for (const space of scan.spaces) {
      const card = el.createDiv({ cls: "cc-card" });
      const head = card.createDiv({ cls: "cc-card-head" });
      head.createEl("strong", { text: space.folder || "/ (tout le vault)" });
      const fresh = space.hasMap ? plugin.engine.newFiles(space).length : 0;
      const status = space.hasMap ? (fresh ? `${fresh} nouveau(x)` : "à jour") : "pas encore organisé";
      head.createSpan({ cls: `cc-badge ${space.hasMap ? (fresh ? "cc-badge-new" : "cc-badge-ok") : "cc-badge-todo"}`, text: status });
      card.createDiv({
        cls: "cc-muted",
        text: `${space.structure.fileCount} fichiers · ${space.structure.subfolderCount} dossiers · ${Math.round(space.structure.filedRatio * 100)} % rangés${space.subspaces.length ? ` · ${space.subspaces.length} sous-dossier(s) géré(s)` : ""}`,
      });
      if (space.config.instructions) card.createDiv({ cls: "cc-muted cc-instr", text: `« ${space.config.instructions} »` });
      const row = card.createDiv({ cls: "cc-card-actions" });
      const link = (text: string, fn: () => void, cls = "") => {
        const a = row.createEl("button", { text, cls });
        a.disabled = busy;
        a.onclick = fn;
      };
      if (space.hasMap) {
        link("Dashboard", () => void plugin.openFile(space.generated.canvas));
        link("Index", () => void plugin.openFile(space.generated.index));
        if (fresh) link("Agréger", () => void plugin.aggregate([space.folder]), "mod-cta");
        link("Réorganiser", () => void plugin.organise([space.folder]));
      } else {
        link("Organiser", () => void plugin.organise([space.folder]), "mod-cta");
      }
      link("Consignes", () => void plugin.editInstructions(space.folder));
      link("Retirer", () => void plugin.removeSpace(space.folder));
    }

    const candidates = plugin.candidates();
    if (candidates.length) {
      const box = el.createDiv({ cls: "cc-candidates" });
      box.createEl("h5", { text: "Autres dossiers" });
      for (const folder of candidates.slice(0, 12)) {
        const row = box.createDiv({ cls: "cc-candidate" });
        row.createSpan({ text: folder });
        const b = row.createEl("button", { text: "Organiser" });
        b.disabled = busy;
        b.onclick = () => void plugin.addFolder(folder);
      }
      box.createDiv({ cls: "cc-muted", text: "Clic droit sur n'importe quel dossier de l'explorateur → « Vault Curator : organiser ce dossier »." });
    }
  }
}
