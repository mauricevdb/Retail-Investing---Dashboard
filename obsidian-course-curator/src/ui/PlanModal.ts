import { App, Modal, setIcon } from "obsidian";
import { relativeTo } from "../core/paths";
import { CheckedOp, OpKind, PlanOp } from "../core/types";
import { Engine, PreparedPlan } from "../engine";

export type ReviewResult = { action: "apply"; selected: boolean[] } | { action: "skip" } | { action: "stop" };

const GROUPS: { kind: OpKind; title: string; icon: string }[] = [
  { kind: "mkdir", title: "Dossiers à créer", icon: "folder-plus" },
  { kind: "move", title: "Déplacements et renommages", icon: "folder-input" },
  { kind: "archive", title: "Archivage (rien n'est supprimé)", icon: "archive" },
  { kind: "transcribe", title: "Transcriptions de photos", icon: "scan-text" },
  { kind: "create_note", title: "Notes créées", icon: "file-plus" },
  { kind: "append_note", title: "Ajouts à des notes existantes", icon: "file-pen-line" },
];

const DECISION: Record<string, string> = { keep: "conservé et lié", merge: "repris puis archivé", archive: "archivé" };

/** Shows a plan op by op; the user toggles, edits destinations, then applies. */
export class PlanModal extends Modal {
  private ops: PlanOp[];
  private selected: boolean[];
  private checked: CheckedOp[];
  private editing: number | null = null;
  private resolve!: (r: ReviewResult) => void;
  private settled = false;
  private listEl!: HTMLElement;
  private footerInfo!: HTMLElement;

  constructor(
    app: App,
    private readonly engine: Engine,
    private readonly prepared: PreparedPlan,
    private readonly position: string,
  ) {
    super(app);
    this.ops = prepared.plan.ops.map((o) => ({ ...o }));
    this.checked = prepared.checked;
    this.selected = this.checked.map((c) => !c.error);
  }

  review(): Promise<ReviewResult> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(r: ReviewResult) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(r);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve({ action: "skip" });
    }
  }

  onOpen() {
    const { contentEl, prepared } = this;
    const { plan } = prepared;
    this.modalEl.addClass("course-curator-modal");
    this.titleEl.setText(`${prepared.mode === "onboard" ? "Organisation" : "Nouveaux documents"} — ${plan.course}  ${this.position}`);

    contentEl.createEl("p", { text: plan.summary, cls: "cc-summary" });

    if (plan.questions.length) {
      const q = contentEl.createDiv({ cls: "callout cc-questions" });
      q.createDiv({ cls: "callout-title", text: "Points à vérifier" });
      const ul = q.createEl("ul");
      for (const question of plan.questions) ul.createEl("li", { text: question });
    }

    if (plan.dashboards.length) {
      const d = contentEl.createEl("details", { cls: "cc-section" });
      d.open = true;
      d.createEl("summary", { text: `Dashboards existants (${plan.dashboards.length})` });
      const ul = d.createEl("ul");
      for (const dash of plan.dashboards) {
        const li = ul.createEl("li");
        li.createEl("code", { text: relativeTo(dash.path, plan.folder) });
        li.appendText(` → ${DECISION[dash.decision] ?? dash.decision} — ${dash.rationale}`);
      }
    }

    this.renderStructure(contentEl);

    this.listEl = contentEl.createDiv({ cls: "cc-ops" });
    this.renderOps();

    const footer = contentEl.createDiv({ cls: "cc-footer" });
    this.footerInfo = footer.createDiv({ cls: "cc-footer-info" });
    const buttons = footer.createDiv({ cls: "cc-footer-buttons" });
    buttons.createEl("button", { text: "Tout arrêter" }).onclick = () => this.finish({ action: "stop" });
    buttons.createEl("button", { text: "Passer ce cours" }).onclick = () => this.finish({ action: "skip" });
    const apply = buttons.createEl("button", { text: "Appliquer", cls: "mod-cta" });
    apply.onclick = () => {
      this.prepared.plan.ops = this.ops;
      this.finish({ action: "apply", selected: this.selected });
    };
    this.updateFooter();
  }

  /** Preview of the resulting skill tree, so the user validates the structure, not just moves. */
  private renderStructure(parent: HTMLElement) {
    const { prepared } = this;
    const d = parent.createEl("details", { cls: "cc-section" });
    d.open = prepared.mode === "onboard";
    if (prepared.mode === "onboard") {
      const modules = prepared.plan.courseMap.modules;
      d.createEl("summary", { text: `Skill tree proposé (${modules.length} modules)` });
      const ol = d.createEl("ol", { cls: "cc-tree" });
      for (const m of modules) {
        const li = ol.createEl("li");
        li.createEl("strong", { text: m.title });
        const count = m.resources.length + m.children.reduce((n, c) => n + c.resources.length, 0);
        li.appendText(` — ${count} doc(s)`);
        if (m.prerequisites.length) li.createSpan({ cls: "cc-muted", text: ` · après ${m.prerequisites.join(", ")}` });
        if (m.summary) li.createDiv({ cls: "cc-muted", text: m.summary });
        if (m.children.length) {
          const sub = li.createEl("ul");
          for (const c of m.children) sub.createEl("li", { text: c.title });
        }
      }
      if (prepared.plan.courseMap.transverse.length) d.createEl("p", { text: `+ ${prepared.plan.courseMap.transverse.length} ressource(s) transverse(s)` });
    } else {
      const patch = prepared.patch!;
      d.createEl("summary", { text: "Effet sur le skill tree" });
      const ul = d.createEl("ul");
      const titles = new Map(prepared.baseMap!.modules.flatMap((m) => [m, ...m.children]).map((m) => [m.id, m.title]));
      for (const nm of patch.newModules) ul.createEl("li", { text: `Nouveau module : ${nm.title}` });
      for (const a of patch.assignments) {
        ul.createEl("li", { text: `${a.label} → ${a.moduleId ? (titles.get(a.moduleId) ?? patch.newModules.find((n) => n.id === a.moduleId)?.title ?? a.moduleId) : "ressources transverses"}` });
      }
      for (const u of patch.conceptUpdates) ul.createEl("li", { text: `${titles.get(u.moduleId) ?? u.moduleId} : + ${u.concepts.join(", ")}` });
    }
  }

  private recheck() {
    this.checked = this.engine.recheck(this.prepared, this.ops, this.selected);
    this.renderOps();
    this.updateFooter();
  }

  private renderOps() {
    const { listEl, prepared } = this;
    listEl.empty();
    if (!this.checked.length) {
      listEl.createEl("p", { cls: "cc-muted", text: "Aucune opération sur les fichiers : seuls le skill tree et l'index seront (re)générés." });
    }
    const rel = (p: string | null) => (p ? relativeTo(p, prepared.plan.folder) || p : "—");

    for (const group of GROUPS) {
      const items = this.checked.filter((c) => c.kind === group.kind);
      if (!items.length) continue;
      const section = listEl.createDiv({ cls: "cc-group" });
      const head = section.createDiv({ cls: "cc-group-head" });
      const all = head.createEl("input", { type: "checkbox" });
      all.checked = items.every((i) => this.selected[i.index] || i.error);
      all.onchange = () => {
        for (const i of items) if (!i.error) this.selected[i.index] = all.checked;
        this.recheck();
      };
      setIcon(head.createSpan({ cls: "cc-icon" }), group.icon);
      head.createSpan({ text: `${group.title} (${items.length})` });

      for (const op of items) {
        const row = section.createDiv({ cls: `cc-op${op.error ? " cc-invalid" : ""}${this.selected[op.index] ? "" : " cc-off"}` });
        const box = row.createEl("input", { type: "checkbox" });
        box.checked = this.selected[op.index] && !op.error;
        box.disabled = !!op.error;
        box.onchange = () => {
          this.selected[op.index] = box.checked;
          this.recheck();
        };
        const body = row.createDiv({ cls: "cc-op-body" });
        const line = body.createDiv({ cls: "cc-op-line" });
        if (op.kind === "move" || op.kind === "archive" || op.kind === "transcribe") {
          line.createEl("code", { text: rel(op.source) });
          line.createSpan({ text: " → " });
        }
        if (this.editing === op.index) {
          const input = line.createEl("input", { type: "text", value: op.target ?? "", cls: "cc-edit" });
          input.focus();
          const commit = () => {
            this.ops[op.index] = { ...this.ops[op.index], target: input.value.trim() || this.ops[op.index].target };
            this.editing = null;
            this.recheck();
          };
          input.onkeydown = (e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              this.editing = null;
              this.renderOps();
            }
          };
          input.onblur = commit;
        } else {
          line.createEl("code", { text: rel(op.target) });
          if (op.kind === "move") {
            const edit = line.createSpan({ cls: "cc-edit-btn clickable-icon", attr: { "aria-label": "Modifier la destination" } });
            setIcon(edit, "pencil");
            edit.onclick = () => {
              this.editing = op.index;
              this.renderOps();
            };
          }
        }
        body.createDiv({ cls: "cc-muted", text: op.reason });
        if (op.error) body.createDiv({ cls: "cc-error", text: `Ignorée : ${op.error}` });
        if (op.content && (op.kind === "create_note" || op.kind === "append_note" || op.kind === "transcribe")) {
          const det = body.createEl("details");
          det.createEl("summary", { text: "Aperçu" });
          det.createEl("pre", { text: op.content.slice(0, 3000) });
        }
      }
    }
  }

  private updateFooter() {
    const n = this.checked.filter((c) => this.selected[c.index] && !c.error).length;
    const invalid = this.checked.filter((c) => c.error).length;
    this.footerInfo.setText(
      `${n} opération(s) sélectionnée(s)${invalid ? ` · ${invalid} ignorée(s) car invalides` : ""} · le skill tree et l'index seront mis à jour · tout est annulable`,
    );
  }
}
