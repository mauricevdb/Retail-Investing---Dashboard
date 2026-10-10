import { App, Modal, setIcon } from "obsidian";
import { relativeTo } from "../core/paths";
import { CheckedOp, Feedback, OpKind, PlanOp } from "../core/types";
import { Engine, PreparedPlan } from "../engine";

export type ReviewResult = { action: "apply"; prepared: PreparedPlan; selected: boolean[] } | { action: "skip" } | { action: "stop" };
export type Reviser = (prepared: PreparedPlan, feedback: Feedback, signal: AbortSignal) => Promise<PreparedPlan>;

const GROUPS: { kind: OpKind; title: string; icon: string }[] = [
  { kind: "mkdir", title: "Dossiers à créer", icon: "folder-plus" },
  { kind: "move", title: "Déplacements et renommages", icon: "folder-input" },
  { kind: "archive", title: "Archivage (rien n'est supprimé)", icon: "archive" },
  { kind: "transcribe", title: "Transcriptions", icon: "scan-text" },
  { kind: "create_note", title: "Notes créées", icon: "file-plus" },
  { kind: "append_note", title: "Ajouts à des notes existantes", icon: "file-pen-line" },
];

const DECISION: Record<string, string> = { keep: "conservé et lié", merge: "repris puis archivé", archive: "archivé" };
const LINKS: Record<string, string> = { prerequisite: "flèches = prérequis", sequence: "flèches = étapes successives", none: "sections indépendantes" };

/**
 * The plan, as a conversation: the user reads Claude's understanding and plan, answers its
 * questions, comments ops, unticks or edits them, and either sends that feedback for a revised
 * version or validates for good.
 */
export class PlanModal extends Modal {
  private prepared!: PreparedPlan;
  private ops: PlanOp[] = [];
  private selected: boolean[] = [];
  private checked: CheckedOp[] = [];
  private answers: string[] = [];
  private comments = new Map<number, string>();
  private openComments = new Set<number>();
  private edits = new Map<number, string>();
  private general = "";
  private editing: number | null = null;
  private busy = false;
  private warnedUnsent = false;
  private resolve!: (r: ReviewResult) => void;
  private settled = false;
  private listEl!: HTMLElement;
  private footerInfo!: HTMLElement;
  private abort: AbortController | null = null;

  constructor(
    app: App,
    private readonly engine: Engine,
    prepared: PreparedPlan,
    private readonly position: string,
    private readonly reviser: Reviser,
  ) {
    super(app);
    this.load(prepared);
  }

  private load(prepared: PreparedPlan) {
    this.prepared = prepared;
    this.ops = prepared.plan.ops.map((o) => ({ ...o }));
    this.checked = prepared.checked;
    this.selected = this.checked.map((c) => !c.error);
    this.answers = prepared.plan.questions.map(() => "");
    this.comments.clear();
    this.openComments.clear();
    this.edits.clear();
    this.general = "";
    this.editing = null;
    this.warnedUnsent = false;
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
    this.abort?.abort();
    this.resolve(r);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.abort?.abort();
      this.resolve({ action: "skip" });
    }
  }

  onOpen() {
    this.modalEl.addClass("course-curator-modal");
    this.render();
  }

  private feedback(): Feedback {
    const refused = this.checked.filter((c) => !c.error && !this.selected[c.index]).map((c) => c.index);
    return {
      answers: this.prepared.plan.questions.map((question, i) => ({ question, answer: this.answers[i] ?? "" })),
      opComments: [...this.comments].map(([index, comment]) => ({ index, comment })).filter((c) => c.comment.trim()),
      refused,
      edited: [...this.edits].map(([index, target]) => ({ index, target })),
      general: this.general,
    };
  }

  private hasFeedback(): boolean {
    const f = this.feedback();
    return f.answers.some((a) => a.answer.trim()) || f.opComments.length > 0 || f.edited.length > 0 || f.general.trim() !== "" || f.refused.length > 0;
  }

  private hasUnsentText(): boolean {
    const f = this.feedback();
    return f.answers.some((a) => a.answer.trim()) || f.opComments.length > 0 || f.general.trim() !== "";
  }

  private render() {
    const { contentEl, prepared } = this;
    const { plan } = prepared;
    contentEl.empty();
    const what = prepared.mode === "initial" ? "Organisation" : "Nouveaux documents";
    this.titleEl.setText(`${what} — ${plan.space} · version ${prepared.round}  ${this.position}`);

    if (this.busy) {
      const box = contentEl.createDiv({ cls: "cc-busy" });
      box.createDiv({ cls: "cc-spinner" });
      box.createEl("p", { text: "Claude révise le plan avec tes retours…" });
      box.createEl("button", { text: "Annuler la révision" }).onclick = () => this.abort?.abort();
      return;
    }

    if (plan.changes.length) {
      const c = contentEl.createDiv({ cls: "callout cc-changes" });
      c.createDiv({ cls: "callout-title", text: "Ce qui a changé dans cette version" });
      const ul = c.createEl("ul");
      for (const ch of plan.changes) ul.createEl("li", { text: ch });
    }

    if (prepared.mode === "initial") {
      const u = plan.understanding;
      const d = contentEl.createDiv({ cls: "cc-understanding" });
      d.createEl("h4", { text: `Ma compréhension du dossier${u.kind ? ` · ${u.kind}` : ""}` });
      if (u.purpose) this.labelled(d, "À quoi il sert", u.purpose);
      if (u.usage) this.labelled(d, "Comment tu t'en sers", u.usage);
      if (u.principle) this.labelled(d, "Principe d'organisation", u.principle);
      d.createDiv({ cls: "cc-muted", text: "Si je me trompe, dis-le dans le commentaire général : je révise tout le plan en conséquence." });
    }

    contentEl.createEl("p", { text: plan.summary, cls: "cc-summary" });

    if (plan.questions.length) {
      const q = contentEl.createDiv({ cls: "callout cc-questions" });
      q.createDiv({ cls: "callout-title", text: "Mes questions (réponds à celles que tu veux)" });
      plan.questions.forEach((question, i) => {
        const row = q.createDiv({ cls: "cc-question" });
        row.createDiv({ text: question });
        const area = row.createEl("textarea", { cls: "cc-answer", attr: { rows: "2", placeholder: "Ta réponse…" } });
        area.value = this.answers[i] ?? "";
        area.oninput = () => {
          this.answers[i] = area.value;
          this.updateFooter();
        };
      });
    }

    this.renderStructure(contentEl);

    if (plan.dashboards.length) {
      const d = contentEl.createEl("details", { cls: "cc-section" });
      d.open = true;
      d.createEl("summary", { text: `Dashboards existants (${plan.dashboards.length})` });
      const ul = d.createEl("ul");
      for (const dash of plan.dashboards) {
        const li = ul.createEl("li");
        li.createEl("code", { text: relativeTo(dash.path, plan.folder) || dash.path });
        li.appendText(` → ${DECISION[dash.decision] ?? dash.decision} — ${dash.rationale}`);
      }
    }

    this.listEl = contentEl.createDiv({ cls: "cc-ops" });
    this.renderOps();

    const general = contentEl.createDiv({ cls: "cc-general" });
    general.createEl("h4", { text: "Autre chose à dire sur ce plan ?" });
    const area = general.createEl("textarea", {
      attr: { rows: "3", placeholder: "Une correction de compréhension, une préférence (« je préfère classer par année »), un regroupement à revoir…" },
    });
    area.value = this.general;
    area.oninput = () => {
      this.general = area.value;
      this.updateFooter();
    };

    const footer = contentEl.createDiv({ cls: "cc-footer" });
    this.footerInfo = footer.createDiv({ cls: "cc-footer-info" });
    const buttons = footer.createDiv({ cls: "cc-footer-buttons" });
    buttons.createEl("button", { text: "Tout arrêter" }).onclick = () => this.finish({ action: "stop" });
    buttons.createEl("button", { text: "Passer" }).onclick = () => this.finish({ action: "skip" });
    const revise = buttons.createEl("button", { text: "Réviser avec mes retours" });
    revise.onclick = () => void this.revise();
    const apply = buttons.createEl("button", { text: "Valider et appliquer", cls: "mod-cta" });
    apply.onclick = () => {
      if (this.hasUnsentText() && !this.warnedUnsent) {
        this.warnedUnsent = true;
        this.updateFooter();
        return;
      }
      this.finish({ action: "apply", prepared: this.prepared, selected: this.selected });
    };
    this.updateFooter();
  }

  private labelled(parent: HTMLElement, label: string, text: string) {
    const p = parent.createDiv({ cls: "cc-labelled" });
    p.createEl("strong", { text: `${label} : ` });
    p.appendText(text);
  }

  private async revise() {
    if (!this.hasFeedback()) {
      this.footerInfo.setText("Écris d'abord une réponse ou un commentaire, ou décoche une opération : c'est ce que Claude va intégrer.");
      return;
    }
    const feedback = this.feedback();
    this.busy = true;
    this.abort = new AbortController();
    this.render();
    try {
      const next = await this.reviser(this.prepared, feedback, this.abort.signal);
      if (this.settled) return;
      this.load(next);
    } catch (e) {
      if (!this.settled && !this.abort.signal.aborted) {
        this.busy = false;
        this.render();
        this.footerInfo.setText(`La révision a échoué : ${(e as Error).message}`);
        return;
      }
    } finally {
      this.busy = false;
      this.abort = null;
    }
    if (!this.settled) {
      this.render();
      this.modalEl.scrollTo({ top: 0 });
    }
  }

  /** Preview of the resulting dashboard, so the user validates the structure, not just moves. */
  private renderStructure(parent: HTMLElement) {
    const { prepared } = this;
    const d = parent.createEl("details", { cls: "cc-section" });
    d.open = prepared.mode === "initial";
    if (prepared.mode === "initial") {
      const map = prepared.plan.map;
      d.createEl("summary", { text: `Dashboard proposé : ${map.dashboardTitle || "sections"} (${map.sections.length} sections, ${LINKS[map.linkKind] ?? ""})` });
      const ol = d.createEl("ol", { cls: "cc-tree" });
      const titles = new Map(map.sections.map((s) => [s.id, s.title]));
      for (const m of map.sections) {
        const li = ol.createEl("li");
        li.createEl("strong", { text: m.title });
        const count = m.resources.length + m.children.reduce((n, c) => n + c.resources.length, 0);
        li.appendText(` — ${count} doc(s)`);
        if (m.folder) li.createSpan({ cls: "cc-muted", text: ` · ${relativeTo(m.folder, prepared.plan.folder) || m.folder}/` });
        if (m.dependsOn.length) li.createSpan({ cls: "cc-muted", text: ` · après ${m.dependsOn.map((id) => titles.get(id) ?? id).join(", ")}` });
        if (m.summary) li.createDiv({ cls: "cc-muted", text: m.summary });
        if (m.children.length) {
          const sub = li.createEl("ul");
          for (const c of m.children) sub.createEl("li", { text: c.title });
        }
      }
      if (map.transverse.length) d.createEl("p", { text: `+ ${map.transverse.length} ressource(s) transverse(s)` });
      if (map.conventions) {
        const c = d.createEl("details");
        c.createEl("summary", { text: "Règles de rangement pour les futurs documents" });
        c.createEl("pre", { text: map.conventions });
      }
    } else {
      const patch = prepared.patch!;
      d.createEl("summary", { text: "Effet sur le dashboard" });
      const ul = d.createEl("ul");
      const all = prepared.baseMap!.sections.flatMap((m) => [m, ...m.children]);
      const titles = new Map(all.map((m) => [m.id, m.title]));
      for (const ns of patch.newSections) ul.createEl("li", { text: `Nouvelle section : ${ns.title}` });
      for (const a of patch.assignments) {
        const target = a.sectionId ? (titles.get(a.sectionId) ?? patch.newSections.find((n) => n.id === a.sectionId)?.title ?? a.sectionId) : "ressources transverses";
        ul.createEl("li", { text: `${a.label} → ${target}` });
      }
      for (const u of patch.keywordUpdates) ul.createEl("li", { text: `${titles.get(u.sectionId) ?? u.sectionId} : + ${u.keywords.join(", ")}` });
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
      listEl.createEl("p", { cls: "cc-muted", text: "Aucune opération sur les fichiers : seuls le dashboard et l'index seront (re)générés." });
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
            const value = input.value.trim();
            if (value && value !== this.ops[op.index].target) {
              this.ops[op.index] = { ...this.ops[op.index], target: value };
              this.edits.set(op.index, value);
            }
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
          if (op.kind === "move") this.iconButton(line, "pencil", "Modifier la destination", () => (this.editing = op.index));
        }
        this.iconButton(line, this.comments.get(op.index)?.trim() ? "message-square-text" : "message-square", "Commenter cette opération", () => {
          if (this.openComments.has(op.index)) this.openComments.delete(op.index);
          else this.openComments.add(op.index);
        });
        body.createDiv({ cls: "cc-muted", text: op.reason });
        if (op.error) body.createDiv({ cls: "cc-error", text: `Ignorée : ${op.error}` });
        if (this.openComments.has(op.index)) {
          const area = body.createEl("textarea", { cls: "cc-comment", attr: { rows: "2", placeholder: "Ton commentaire sur cette opération…" } });
          area.value = this.comments.get(op.index) ?? "";
          area.oninput = () => {
            this.comments.set(op.index, area.value);
            this.updateFooter();
          };
        }
        if (op.content && (op.kind === "create_note" || op.kind === "append_note" || op.kind === "transcribe")) {
          const det = body.createEl("details");
          det.createEl("summary", { text: "Aperçu" });
          det.createEl("pre", { text: op.content.slice(0, 3000) });
        }
      }
    }
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
    const b = parent.createSpan({ cls: "cc-edit-btn clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.onclick = () => {
      onClick();
      this.renderOps();
    };
  }

  private updateFooter() {
    if (!this.footerInfo) return;
    const n = this.checked.filter((c) => this.selected[c.index] && !c.error).length;
    const invalid = this.checked.filter((c) => c.error).length;
    if (this.warnedUnsent && this.hasUnsentText()) {
      this.footerInfo.setText("Tes réponses et commentaires n'ont pas été envoyés à Claude. « Réviser avec mes retours » pour qu'il les intègre, ou « Valider et appliquer » à nouveau pour appliquer le plan tel quel.");
      this.footerInfo.addClass("cc-warning");
      return;
    }
    this.footerInfo.removeClass("cc-warning");
    const pending = this.hasFeedback() ? " · retours en attente : « Réviser » pour qu'ils soient intégrés" : "";
    this.footerInfo.setText(`${n} opération(s) retenue(s)${invalid ? ` · ${invalid} ignorée(s) car invalides` : ""} · dashboard et index mis à jour · tout est annulable${pending}`);
  }
}
