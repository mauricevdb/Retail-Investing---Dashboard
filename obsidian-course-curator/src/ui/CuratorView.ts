import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type CourseCuratorPlugin from "../main";

export const VIEW_TYPE = "course-curator";

/** Side panel: one card per course with its state and actions, plus the running task. */
export class CuratorView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: CourseCuratorPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Course Curator";
  }
  getIcon() {
    return "graduation-cap";
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
    top.createEl("h4", { text: "Course Curator" });
    top.createDiv({ cls: "cc-muted", text: `Claude via ${plugin.cfg.backend === "claude-code" ? "Claude Code (abonnement)" : "API"}` });

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

    const actions = el.createDiv({ cls: "cc-actions" });
    const busy = !!task;
    const pending = scan.courses.filter((c) => !c.hasMap);
    const button = (text: string, icon: string, fn: () => void, cta = false) => {
      const b = actions.createEl("button", { cls: cta ? "mod-cta" : "" });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: ` ${text}` });
      b.disabled = busy;
      b.onclick = fn;
    };
    if (pending.length) button(`Organiser ${pending.length} cours non organisé(s)`, "wand-2", () => void plugin.onboard(pending.map((c) => c.folder)), true);
    const newCount = plugin.countNew(scan);
    button(newCount ? `Agréger ${newCount} nouveau(x) document(s)` : "Chercher de nouveaux documents", "inbox", () => void plugin.aggregate(), !pending.length && newCount > 0);
    if (plugin.data.journal.length) button(`Annuler : ${plugin.data.journal[0].label}`, "undo-2", () => void plugin.undo());

    if (scan.inbox.length) {
      el.createDiv({ cls: "cc-inbox", text: `📥 ${scan.inbox.length} document(s) dans « ${plugin.cfg.inboxFolder} »` });
    }

    for (const course of scan.courses) {
      const card = el.createDiv({ cls: "cc-card" });
      const head = card.createDiv({ cls: "cc-card-head" });
      head.createEl("strong", { text: course.name });
      const fresh = course.hasMap ? plugin.engine.newFiles(course).length : 0;
      const status = course.hasMap ? (fresh ? `${fresh} nouveau(x)` : "à jour") : "pas encore organisé";
      head.createSpan({ cls: `cc-badge ${course.hasMap ? (fresh ? "cc-badge-new" : "cc-badge-ok") : "cc-badge-todo"}`, text: status });
      card.createDiv({
        cls: "cc-muted",
        text: `${course.structure.fileCount} fichiers · ${course.structure.subfolderCount} dossiers · ${Math.round(course.structure.filedRatio * 100)} % rangés`,
      });
      const row = card.createDiv({ cls: "cc-card-actions" });
      const link = (text: string, fn: () => void, disabled = false) => {
        const a = row.createEl("button", { text });
        a.disabled = disabled || busy;
        a.onclick = fn;
      };
      if (course.hasMap) {
        link("Skill tree", () => void plugin.openFile(course.generated.canvas));
        link("Index", () => void plugin.openFile(course.generated.index));
        if (fresh) link("Agréger", () => void plugin.aggregate([course.folder]));
        link("Réorganiser", () => void plugin.onboard([course.folder]));
      } else {
        link("Organiser", () => void plugin.onboard([course.folder]));
      }
    }
    if (!scan.courses.length) {
      el.createEl("p", {
        cls: "cc-muted",
        text: `Aucun cours trouvé${plugin.cfg.coursesRoot ? ` dans « ${plugin.cfg.coursesRoot} »` : ""}. Chaque sous-dossier est considéré comme un cours (réglage « Dossier des cours »).`,
      });
    }
  }
}
