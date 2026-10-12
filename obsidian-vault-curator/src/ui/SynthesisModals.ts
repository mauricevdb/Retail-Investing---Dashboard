import { App, Component, MarkdownRenderer, Modal, TFile } from "obsidian";
import { relativeTo } from "../core/paths";
import { allSections } from "../core/plan";
import { SynthesisFeedback, SynthesisJob } from "../learn/synthesizer";

export type PlanReview = { action: "write"; job: SynthesisJob; comments: Map<string, string> } | { action: "skip" } | { action: "stop" };
export type PlanReviser = (job: SynthesisJob, feedback: SynthesisFeedback, signal: AbortSignal) => Promise<SynthesisJob>;
export type TranscriptSaver = (job: SynthesisJob, sourceId: string, text: string) => Promise<void>;

/** Base: a modal that resolves once, with a "busy" screen while Claude works. */
abstract class AsyncModal<T> extends Modal {
  protected resolve!: (r: T) => void;
  protected settled = false;
  protected busy: string | null = null;
  protected abort: AbortController | null = null;

  constructor(
    app: App,
    private readonly onDismiss: T,
  ) {
    super(app);
  }

  run(): Promise<T> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  protected finish(r: T) {
    if (this.settled) return;
    this.settled = true;
    this.abort?.abort();
    this.resolve(r);
    this.close();
  }

  onOpen() {
    this.modalEl.addClass("course-curator-modal");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.abort?.abort();
      this.resolve(this.onDismiss);
    }
  }

  protected abstract render(): void;

  protected renderBusy() {
    const box = this.contentEl.createDiv({ cls: "cc-busy" });
    box.createDiv({ cls: "cc-spinner" });
    box.createEl("p", { text: this.busy ?? "" });
    box.createEl("button", { text: "Annuler" }).onclick = () => this.abort?.abort();
  }

  /** Runs a Claude step with the busy screen; returns null when cancelled or failed (error shown). */
  protected async step<R>(message: string, fn: (signal: AbortSignal) => Promise<R>): Promise<R | null> {
    this.busy = message;
    this.abort = new AbortController();
    this.render();
    try {
      return await fn(this.abort.signal);
    } catch (e) {
      if (!this.settled && !this.abort.signal.aborted) this.error = (e as Error).message;
      return null;
    } finally {
      this.busy = null;
      this.abort = null;
      if (!this.settled) this.render();
    }
  }

  protected error: string | null = null;

  protected showError(parent: HTMLElement) {
    if (!this.error) return;
    parent.createDiv({ cls: "cc-error", text: `Échec : ${this.error}` });
    this.error = null;
  }
}

/**
 * Stage 1: what the lot contains (with the photo transcriptions, correctable), and the proposed notes.
 * The user answers, comments, corrects, and asks for a revision as many times as needed.
 */
export class SynthesisPlanModal extends AsyncModal<PlanReview> {
  private answers: string[] = [];
  private ficheComments = new Map<string, string>();
  private transcripts = new Map<string, string>();
  private general = "";

  constructor(
    app: App,
    private job: SynthesisJob,
    private readonly position: string,
    private readonly reviser: PlanReviser,
    private readonly saveTranscript: TranscriptSaver,
  ) {
    super(app, { action: "skip" });
    this.reset();
  }

  private reset() {
    this.answers = this.job.plan.questions.map(() => "");
    this.ficheComments.clear();
    this.transcripts.clear();
    this.general = "";
  }

  private feedback(): SynthesisFeedback {
    return {
      answers: this.job.plan.questions.map((question, i) => ({ question, answer: this.answers[i] ?? "" })),
      ficheComments: [...this.ficheComments].map(([id, comment]) => ({ id, comment })).filter((c) => c.comment.trim()),
      general: this.general,
      transcriptions: [...this.transcripts].map(([sourceId, text]) => ({ sourceId, text })),
    };
  }

  private hasFeedback() {
    const f = this.feedback();
    return f.answers.some((a) => a.answer.trim()) || f.ficheComments.length > 0 || f.general.trim() !== "" || f.transcriptions.length > 0;
  }

  protected render() {
    const { contentEl, job } = this;
    const { plan } = job;
    contentEl.empty();
    this.titleEl.setText(`Synthèse — ${plan.session || job.lot.name} · version ${job.round}  ${this.position}`);
    if (this.busy) return this.renderBusy();
    this.showError(contentEl);

    if (plan.changes.length) {
      const c = contentEl.createDiv({ cls: "callout cc-changes" });
      c.createDiv({ cls: "callout-title", text: "Ce qui a changé dans cette version" });
      const ul = c.createEl("ul");
      for (const ch of plan.changes) ul.createEl("li", { text: ch });
    }
    contentEl.createEl("p", { cls: "cc-summary", text: plan.summary });

    // What the lot contains.
    const lot = contentEl.createEl("details", { cls: "cc-section" });
    lot.open = true;
    lot.createEl("summary", { text: `Ce que contiennent les ${job.sources.length} documents` });
    const ul = lot.createEl("ul");
    for (const s of job.sources) {
      const info = plan.sources.find((x) => x.sourceId === s.id);
      const li = ul.createEl("li");
      li.createEl("code", { text: `${s.id} · ${relativeTo(s.path, job.lot.space.folder) || s.path}` });
      if (s.embeddedIn) li.appendText(` (photo de ${s.embeddedIn})`);
      li.appendText(` — ${info ? `${info.role} : ${info.contributes}` : "(non décrit)"} `);
      if (info) {
        const forced = job.extracts.get(s.id)?.survey || s.kind === "notebook" || s.kind === "data" || s.kind === "other";
        const select = li.createEl("select", { cls: "dropdown cc-disposition" });
        select.createEl("option", { value: "integrate", text: "à intégrer puis archiver" });
        select.createEl("option", { value: "keep", text: "à garder en place (référence)" });
        select.value = info.disposition;
        select.disabled = forced || !!s.embeddedIn;
        select.onchange = () => {
          info.disposition = select.value as "integrate" | "keep";
          const used = plan.fiches.some((f) => f.sources.some((x) => x.sourceId === s.id));
          job.unassigned = job.unassigned.filter((id) => id !== s.id);
          if (info.disposition === "integrate" && !used) job.unassigned.push(s.id);
          this.render();
        };
      }
      if (job.unassigned.includes(s.id)) li.createDiv({ cls: "cc-warning-text", text: "⚠ Aucune fiche n'utilise ce document : il ne sera pas archivé. Signale-le dans tes retours." });
    }
    if (plan.issues.length) {
      const c = lot.createDiv({ cls: "callout" });
      c.createDiv({ cls: "callout-title", text: "Points relevés" });
      const l = c.createEl("ul");
      for (const i of plan.issues) l.createEl("li", { text: i });
    }

    this.renderTranscriptions(contentEl);
    this.renderStructure(contentEl);
    this.renderTree(contentEl);

    if (plan.questions.length) {
      const q = contentEl.createDiv({ cls: "callout cc-questions" });
      q.createDiv({ cls: "callout-title", text: "Mes questions (réponds à celles que tu veux)" });
      plan.questions.forEach((question, i) => {
        const row = q.createDiv({ cls: "cc-question" });
        row.createDiv({ text: question });
        const area = row.createEl("textarea", { cls: "cc-answer", attr: { rows: "2", placeholder: "Ta réponse…" } });
        area.value = this.answers[i] ?? "";
        area.oninput = () => (this.answers[i] = area.value);
      });
    }

    const general = contentEl.createDiv({ cls: "cc-general" });
    general.createEl("h4", { text: "Autre chose à dire sur ce plan ?" });
    const area = general.createEl("textarea", { attr: { rows: "3", placeholder: "Découpage des fiches, ordre, une notion oubliée, ta façon de réviser…" } });
    area.value = this.general;
    area.oninput = () => (this.general = area.value);

    const footer = contentEl.createDiv({ cls: "cc-footer" });
    const info = footer.createDiv({ cls: "cc-footer-info", text: "Rien n'est écrit avant « Valider et rédiger ». Après la rédaction, tu reliras les fiches avant qu'elles soient enregistrées." });
    const buttons = footer.createDiv({ cls: "cc-footer-buttons" });
    buttons.createEl("button", { text: "Tout arrêter" }).onclick = () => this.finish({ action: "stop" });
    buttons.createEl("button", { text: "Passer" }).onclick = () => this.finish({ action: "skip" });
    buttons.createEl("button", { text: "Réviser avec mes retours" }).onclick = async () => {
      if (!this.hasFeedback()) return void info.setText("Écris d'abord une réponse, un commentaire ou corrige une transcription : c'est ce que Claude va intégrer.");
      const feedback = this.feedback();
      const next = await this.step("Claude révise le plan avec tes retours…", (signal) => this.reviser(this.job, feedback, signal));
      if (next) {
        this.job = next;
        this.reset();
        this.render();
      }
    };
    buttons.createEl("button", { text: "Valider et rédiger", cls: "mod-cta" }).onclick = async () => {
      // Corrected transcriptions are kept even without a revision.
      for (const [id, text] of this.transcripts) await this.saveTranscript(this.job, id, text);
      this.finish({ action: "write", job: this.job, comments: new Map([...this.ficheComments].filter(([, c]) => c.trim())) });
    };
  }

  private renderTranscriptions(parent: HTMLElement) {
    const { job } = this;
    const photos = job.sources.filter((s) => s.kind === "image");
    const others = job.sources.filter((s) => s.kind !== "image");
    const d = parent.createEl("details", { cls: "cc-section" });
    d.open = photos.length > 0;
    d.createEl("summary", { text: `Transcriptions (${photos.length} photo(s) à relire, ${others.length} autre(s) document(s))` });
    d.createDiv({ cls: "cc-muted", text: "Corrige directement le texte si besoin : la version corrigée sera utilisée pour la rédaction et conservée dans le document « Transcriptions » de la séance." });
    for (const s of photos) {
      const e = job.extracts.get(s.id);
      const box = d.createDiv({ cls: "cc-transcript" });
      box.createEl("strong", { text: `${s.id} — ${relativeTo(s.path, job.lot.space.folder) || s.path}` });
      if (e?.description) box.createDiv({ cls: "cc-muted", text: e.description });
      const row = box.createDiv({ cls: "cc-transcript-row" });
      const file = this.app.vault.getAbstractFileByPath(s.path);
      if (file instanceof TFile) {
        const img = row.createEl("img", { cls: "cc-thumb", attr: { src: this.app.vault.getResourcePath(file) } });
        img.onclick = () => window.open(this.app.vault.getResourcePath(file));
      }
      const area = row.createEl("textarea", { cls: "cc-transcript-text" });
      area.value = this.transcripts.get(s.id) ?? e?.text ?? "(transcription indisponible)";
      area.oninput = () => this.transcripts.set(s.id, area.value);
      if (e?.uncertain.length) box.createDiv({ cls: "cc-warning-text", text: `Passages incertains : ${e.uncertain.join(" ; ")}` });
    }
    for (const s of others) {
      const e = job.extracts.get(s.id);
      const det = d.createEl("details");
      det.createEl("summary", { text: `${s.id} — ${relativeTo(s.path, job.lot.space.folder) || s.path}${e?.truncated ? ` (${e.truncated})` : ""}` });
      det.createEl("pre", { cls: "cc-merge", text: (e?.text ?? "(contenu indisponible)").slice(0, 20000) });
    }
  }

  /** How the course skill tree changes: order of the modules, earlier notes re-linked. */
  private renderTree(parent: HTMLElement) {
    const { job } = this;
    const { plan } = job;
    const existing = job.map ? allSections(job.map) : [];
    const title = (id: string) => (id === plan.module.id ? plan.module.title : (plan.fiches.find((f) => f.id === id)?.title ?? existing.find((x) => x.id === id)?.title ?? id));
    const d = parent.createEl("details", { cls: "cc-section" });
    d.open = plan.tree.updates.length > 0;
    d.createEl("summary", { text: `Skill tree du cours${plan.tree.updates.length ? ` — ${plan.tree.updates.length} modification(s) de l'existant` : ""}` });
    if (plan.tree.moduleOrder.length) {
      const ol = d.createEl("ol", { cls: "cc-outline" });
      for (const id of plan.tree.moduleOrder) {
        const li = ol.createEl("li", { text: title(id) });
        if (id === plan.module.id) li.createSpan({ cls: "cc-muted", text: plan.module.mode === "new" ? " (nouveau)" : " (complété)" });
      }
    }
    if (plan.tree.updates.length) {
      const ul = d.createEl("ul");
      for (const u of plan.tree.updates) {
        const li = ul.createEl("li");
        li.createEl("strong", { text: title(u.id) });
        li.appendText(` — prérequis : ${u.dependsOn.map(title).join(", ") || "aucun"}${u.summary ? ` ; nouveau résumé : ${u.summary}` : ""}`);
        if (u.why) li.createDiv({ cls: "cc-muted", text: u.why });
      }
    } else d.createDiv({ cls: "cc-muted", text: "Aucun changement sur les modules et fiches existants." });
    d.createDiv({ cls: "cc-muted", text: "Un commentaire sur la place de la séance dans le cours ? Écris-le dans le commentaire général." });
  }

  private renderStructure(parent: HTMLElement) {
    const { job } = this;
    const { plan } = job;
    const d = parent.createEl("details", { cls: "cc-section" });
    d.open = true;
    const m = plan.module;
    d.createEl("summary", { text: `Fiches proposées (${plan.fiches.length}) — module « ${m.title} » (${m.mode === "new" ? "nouveau" : "existant"}, ${relativeTo(m.folder, job.lot.space.folder)}/)` });
    const titles = new Map(plan.fiches.map((f) => [f.id, f.title]));
    for (const [i, f] of plan.fiches.entries()) {
      const card = d.createDiv({ cls: "cc-fiche" });
      const head = card.createDiv({ cls: "cc-fiche-head" });
      head.createEl("strong", { text: `${i + 1}. ${f.title}` });
      head.createSpan({ cls: "cc-muted", text: ` ${f.action === "extend" ? "· complète une fiche existante" : "· nouvelle fiche"} · ${relativeTo(f.path, job.lot.space.folder)}` });
      card.createDiv({ text: `Objectif : ${f.objective}` });
      if (f.dependsOn.length) card.createDiv({ cls: "cc-muted", text: `Prérequis : ${f.dependsOn.map((id) => titles.get(id) ?? id).join(", ")}` });
      const ol = card.createEl("ol", { cls: "cc-outline" });
      for (const o of f.outline) ol.createEl("li", { text: o });
      card.createDiv({ cls: "cc-muted", text: `Sources : ${f.sources.map((x) => `${x.sourceId} (${x.what})`).join(" · ")}` });
      const area = card.createEl("textarea", { cls: "cc-comment", attr: { rows: "1", placeholder: "Un commentaire sur cette fiche ? (découpage, contenu, ordre…)" } });
      area.value = this.ficheComments.get(f.id) ?? "";
      area.oninput = () => this.ficheComments.set(f.id, area.value);
    }
  }
}

export type ResultReview = { action: "apply"; job: SynthesisJob } | { action: "cancel" };
export type FicheRewriter = (job: SynthesisJob, ficheId: string, comment: string, signal: AbortSignal) => Promise<SynthesisJob>;

/** Stage 2: the written notes (rendered), what each source became, then apply. */
export class SynthesisResultModal extends AsyncModal<ResultReview> {
  private comments = new Map<string, string>();
  private component = new Component();

  constructor(
    app: App,
    private job: SynthesisJob,
    private readonly rewriter: FicheRewriter,
  ) {
    super(app, { action: "cancel" });
  }

  onClose() {
    this.component.unload();
    super.onClose();
  }

  protected render() {
    const { contentEl, job } = this;
    contentEl.empty();
    this.titleEl.setText(`Fiches rédigées — ${job.plan.session || job.lot.name}`);
    if (this.busy) return this.renderBusy();
    this.showError(contentEl);

    const covered = job.coverage.filter((c) => c.sourceId.startsWith("S") && c.covered && !c.kept).length;
    const total = job.coverage.filter((c) => c.sourceId.startsWith("S") && !c.kept).length;
    const cov = contentEl.createDiv({ cls: `callout ${covered === total ? "cc-ok" : "cc-questions"}` });
    cov.createDiv({ cls: "callout-title", text: `Contrôle de couverture : ${covered}/${total} document(s) entièrement intégrés` });
    const ul = cov.createEl("ul");
    for (const c of job.coverage) {
      const li = ul.createEl("li");
      li.appendText(`${c.kept ? "↷" : c.covered ? "✓" : "✗"} ${relativeTo(c.path, job.lot.space.folder) || c.path}${c.kept ? " (gardé en place)" : ""}`);
      if (!c.covered && c.missing.length) li.createDiv({ cls: "cc-muted", text: `Manque : ${c.missing.map((m) => m.item).join(" ; ")}` });
    }
    cov.createDiv({ cls: "cc-muted", text: "Les documents ✓ iront dans le dossier « Sources » de la séance, avec un document « Transcriptions ». Les ✗ restent où ils sont, signalés sur le canvas de la séance ; les ↷ (références, notebooks, données) rejoignent « Sources » sans contrôle." });

    for (const w of job.written) {
      const det = contentEl.createEl("details", { cls: "cc-section" });
      det.createEl("summary", { text: `${w.plan.title} — ${relativeTo(w.plan.path, job.lot.space.folder)}${w.before !== null ? " (fiche existante complétée)" : ""}` });
      const view = det.createDiv({ cls: "cc-fiche-preview markdown-rendered" });
      void MarkdownRenderer.render(this.app, w.content.replace(/^---[\s\S]*?\n---\n/, ""), view, w.plan.path, this.component);
      const row = det.createDiv({ cls: "cc-rewrite" });
      const area = row.createEl("textarea", { cls: "cc-comment", attr: { rows: "2", placeholder: "Une demande pour cette fiche ? (plus d'exemples, reformuler une partie, corriger une erreur…)" } });
      area.value = this.comments.get(w.plan.id) ?? "";
      area.oninput = () => this.comments.set(w.plan.id, area.value);
      row.createEl("button", { text: "Réécrire cette fiche" }).onclick = async () => {
        const comment = (this.comments.get(w.plan.id) ?? "").trim();
        if (!comment) return;
        const next = await this.step(`Réécriture de « ${w.plan.title} »…`, (signal) => this.rewriter(this.job, w.plan.id, comment, signal));
        if (next) {
          this.job = next;
          this.comments.delete(w.plan.id);
          this.render();
        }
      };
    }

    const footer = contentEl.createDiv({ cls: "cc-footer" });
    footer.createDiv({ cls: "cc-footer-info", text: "« Appliquer » écrit les fiches dans « Fiches », range les sources dans « Sources », crée le canvas de la séance et met à jour le skill tree du cours. Tout est annulable." });
    const buttons = footer.createDiv({ cls: "cc-footer-buttons" });
    buttons.createEl("button", { text: "Abandonner" }).onclick = () => this.finish({ action: "cancel" });
    buttons.createEl("button", { text: "Appliquer", cls: "mod-cta" }).onclick = () => this.finish({ action: "apply", job: this.job });
  }
}
