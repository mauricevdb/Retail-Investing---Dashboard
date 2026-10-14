// The synthesis pipeline, stage by stage:
//   1. lot      — the raw documents of a session (a folder, a selection, or the new files)
//   2. extract  — full transcription of every document: PDFs page by page, photos with zoomed views
//                 and a verification pass, notes as they are (cached, correctable by the user)
//   3. plan     — Claude reads everything and proposes the study notes and their skill-tree place
//   4. discuss  — the user answers, comments, corrects transcriptions; Claude revises (any number of rounds)
//   5. write    — one call per note, from the full content of its sources
//   6. check    — coverage: every element of every source must be in a note; missing ones are added
//   7. apply    — notes written, sources moved to the archive with an archive document, skill tree updated
import { Engine, Progress } from "../engine";
import { basename, dirname, extname, hash, isInside, join, matchPath, relativeTo, sanitizePath, sanitizeSegment, slugify, uniquePath } from "../core/paths";
import { allSections } from "../core/plan";
import { fileKind, isIgnored, SpaceInventory } from "../core/scan";
import { mapPath } from "../core/settings";
import { DocType, JournalEntry, JournalStep, Resource, SectionNode, SpaceMap, VaultFile } from "../core/types";
import { Attachment } from "../llm/types";
import {
  completePrompt,
  completeSystem,
  CourseContext,
  coveragePrompt,
  coverageSystem,
  pdfPrompt,
  pdfSystem,
  photoPrompt,
  photoSystem,
  planPrompt,
  planRevisionPrompt,
  planSystem,
  verifyPrompt,
  verifySystem,
  writePrompt,
  writeSystem,
} from "./prompts";
import {
  COVERAGE_SCHEMA,
  CoverageAnswer,
  PDF_SCHEMA,
  PdfAnswer,
  PHOTO_SCHEMA,
  PhotoAnswer,
  PLAN_SCHEMA,
  VERIFY_SCHEMA,
  VerifyAnswer,
  WRITE_SCHEMA,
  WriteAnswer,
} from "./schemas";
import { annotateEmbeds, dataPreview, embedsOf, notebookText } from "./content";
import { Coverage, Disposition, Extract, FichePlan, Source, SynthesisPlan, WrittenFiche } from "./types";

export interface Lot {
  space: SpaceInventory;
  name: string;
  /** Folder the lot comes from (emptied and removed after archiving), or null for a selection. */
  folder: string | null;
  files: VaultFile[];
}

export interface SynthesisFeedback {
  answers: { question: string; answer: string }[];
  ficheComments: { id: string; comment: string }[];
  general: string;
  /** Transcriptions corrected by hand, by source id. */
  transcriptions: { sourceId: string; text: string }[];
}

export interface SynthesisJob {
  lot: Lot;
  sources: Source[];
  extracts: Map<string, Extract>;
  course: CourseContext;
  map: SpaceMap | null;
  plan: SynthesisPlan;
  request: { system: string; prompt: string };
  round: number;
  history: string[];
  /** Sources no note uses (they would be lost): shown to the user, never archived. */
  unassigned: string[];
  written: WrittenFiche[];
  coverage: Coverage[];
}

export interface SynthesisReport {
  fiches: string[];
  archived: string[];
  /** Left in place on purpose: reference material, notebooks, data. */
  kept: string[];
  /** Left in place because their content is not fully in the notes yet. */
  pending: string[];
  /** Existing notes and non-course files: left as they are. */
  untouched: string[];
  /** Where each moved source went (old path → new path). */
  moved: Record<string, string>;
  archiveDoc: string;
  canvas: string;
}

const PDF_CHUNK = 10;
/** Text files above this size are data, not something to read. */
const DATA_TEXT_LIMIT = 300 * 1024;
/** Pages of a long PDF given to the plan when it is only skimmed. */
const SURVEY_PAGES = 6;
/** A textbook, a volume of lecture notes or anything in a resources folder is skimmed beyond this. */
const REFERENCE_PAGES = 40;
const REFERENCE_FOLDER = /(^|\/)(\d+ )?(ressources?|resources?|r[ée]f[ée]rences?|books?|livres?|biblio\w*)\//i;
const REFERENCE_NAME = /\b(book|textbook|manuel|primer|ESL\w*|ISLR|proofs?|lecture[ _-]?notes|polycopi\w*|handbook)\b/i;
const VIEW_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export class Synthesizer {
  constructor(private readonly engine: Engine) {}

  private get io() {
    return this.engine.vault;
  }
  private get settings() {
    return this.engine.settings;
  }

  // -------------------------------------------------------------------------
  // 0. Courses

  /**
   * The course a path belongs to. In a "programme" folder (one sub-folder per course), the course is the
   * first-level sub-folder, registered as a learning folder of its own the first time (its own map and
   * skill tree). Elsewhere, the outermost learning folder containing the path: week folders managed on
   * their own by an older version belong to their course.
   */
  async courseFor(path: string): Promise<SpaceInventory | null> {
    const learning = this.settings.spaces.filter((s) => s.mode === "learning" && isInside(path, s.folder)).sort((a, b) => a.folder.length - b.folder.length);
    if (!learning.length) return null;
    const programme = learning.find((s) => s.level === "programme");
    if (!programme) return this.engine.space(learning[0].folder) ?? null;
    const rel = relativeTo(path, programme.folder);
    const first = rel.split("/")[0];
    if (!first) return null;
    const folder = join(programme.folder, first);
    if (!this.io.listFolders().includes(folder)) return null; // a loose file at the programme's root
    const existing = this.settings.spaces.find((s) => s.folder === folder);
    if (!existing) await this.engine.addSpace(folder, "", "learning", "course");
    else if (existing.mode !== "learning" || existing.level !== "course") {
      existing.mode = "learning";
      existing.level = "course";
    }
    return this.engine.space(folder) ?? null;
  }

  /** True when a path lies in another course of the same programme, or in another learning folder. */
  private otherCourse(path: string, courseFolder: string): boolean {
    if (isInside(path, courseFolder)) return false;
    const programme = this.programmeOf(courseFolder);
    if (programme && this.coursesOf(programme.folder).some((c) => isInside(path, c))) return true;
    return this.settings.spaces.some((s) => s.mode === "learning" && s.level !== "programme" && isInside(path, s.folder));
  }

  /** The programme folder a course lives in, if any. */
  programmeOf(folder: string) {
    return this.settings.spaces.find((s) => s.mode === "learning" && s.level === "programme" && s.folder !== folder && isInside(folder, s.folder)) ?? null;
  }

  /** Sub-folders of a programme that are courses (they hold files). */
  coursesOf(programmeFolder: string): string[] {
    const depth = programmeFolder ? programmeFolder.split("/").length + 1 : 1;
    const archive = this.settings.archiveFolder;
    return this.io
      .listFolders()
      .filter((f) => isInside(f, programmeFolder) && f.split("/").length === depth && basename(f) !== archive && basename(f) !== this.settings.archiveRoot)
      .filter((f) => !isIgnored(f, this.settings))
      .filter((f) => this.io.listFiles().some((x) => isInside(x.path, f)))
      .sort();
  }

  /** One lot per sub-folder holding raw documents, plus the loose documents at the course root. */
  async courseLots(space: SpaceInventory): Promise<Lot[]> {
    const folders = new Map<string, string[]>();
    for (const f of space.files) {
      const rel = relativeTo(f.path, space.folder);
      const top = rel.includes("/") ? join(space.folder, rel.split("/")[0]) : space.folder;
      folders.set(top, [...(folders.get(top) ?? []), f.path]);
    }
    // Sub-folders managed on their own by an older version, or holding only a legacy archive, are part of the course.
    for (const sub of space.subspaces) {
      const rel = relativeTo(sub.folder, space.folder);
      const top = join(space.folder, rel.split("/")[0]);
      folders.set(top, folders.get(top) ?? []);
    }
    for (const folder of this.legacyArchives(space.folder)) {
      const rel = relativeTo(folder, space.folder);
      if (rel.includes("/")) folders.set(join(space.folder, rel.split("/")[0]), folders.get(join(space.folder, rel.split("/")[0])) ?? []);
    }
    const lots: Lot[] = [];
    for (const [folder, paths] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
      const lot = folder === space.folder ? await this.lotFromFiles(space, paths, `Documents à la racine de ${space.name}`) : await this.lotFromFolder(space, folder);
      if (lot.files.length) lots.push(lot);
    }
    return lots;
  }

  /** "99 Archive" folders an older version filled inside a course, often with material never integrated. */
  private legacyArchives(folder: string): string[] {
    const name = this.settings.archiveFolder;
    return this.io.listFolders().filter((f) => isInside(f, folder) && f !== folder && basename(f) === name);
  }

  // -------------------------------------------------------------------------
  // 1. Lots

  /** Raw documents of a folder of a learning space (study notes already written by the pipeline are not sources). */
  async lotFromFolder(space: SpaceInventory, folder: string): Promise<Lot> {
    // Folders managed on their own by an older version (e.g. "Semaine 2") belong to the course: take their files too.
    const seen = new Set<string>();
    const files = this.engine
      .scan()
      .spaces.filter((s) => isInside(s.folder, space.folder))
      .flatMap((s) => s.files)
      .filter((f) => isInside(f.path, folder) && !seen.has(f.path) && seen.add(f.path));
    // What an older version moved to a local "99 Archive" without integrating it (notes of photos…) is raw material too.
    const legacy = this.legacyArchives(folder);
    for (const f of this.io.listFiles()) {
      if (legacy.some((a) => isInside(f.path, a)) && !seen.has(f.path) && fileKind(f.path) !== "canvas") {
        seen.add(f.path);
        files.push(f);
      }
    }
    return { space, name: basename(folder) || space.name, folder, files: await this.rawOnly(files) };
  }

  async lotFromFiles(space: SpaceInventory, paths: string[], name?: string): Promise<Lot> {
    const files = space.files.filter((f) => paths.includes(f.path));
    return { space, name: name ?? `${files.length} document(s)`, folder: null, files: await this.rawOnly(files) };
  }

  /** New material of a learning space, one lot per parent folder. */
  async lotsFromNew(space: SpaceInventory, files: VaultFile[]): Promise<Lot[]> {
    const raw = await this.rawOnly(files);
    const byFolder = new Map<string, VaultFile[]>();
    for (const f of raw) byFolder.set(dirname(f.path), [...(byFolder.get(dirname(f.path)) ?? []), f]);
    return [...byFolder].map(([folder, fs]) => ({
      space,
      name: folder === space.folder ? `Nouveaux documents de ${space.name}` : basename(folder),
      folder: folder === space.folder ? null : folder,
      files: fs,
    }));
  }

  private async rawOnly(files: VaultFile[]): Promise<VaultFile[]> {
    const out: VaultFile[] = [];
    for (const f of files) {
      if (fileKind(f.path) === "canvas" || basename(f.path) === "_curator.json") continue;
      if (fileKind(f.path) === "markdown" && /^---[\s\S]*?\ncurator:\s*(fiche|index)\b/m.test((await this.io.read(f.path)).slice(0, 600))) continue;
      out.push(f);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 2. Extraction

  /**
   * The lot's documents, plus the photos and PDFs embedded in its notes, wherever Obsidian stored them
   * (attachments folder, vault root…): a note "Photos CM" made of `![[IMG_….jpg]]` is a set of photos to transcribe.
   */
  async collect(lot: Lot): Promise<{ sources: Source[]; notes: Map<string, { text: string; embeds: Map<string, string>; missing: string[] }> }> {
    const sources: Source[] = lot.files.map((f, i) => ({ id: `S${i + 1}`, path: f.path, kind: sourceKind(f.path, f.size), size: f.size, mtime: f.mtime }));
    const stats = new Map(this.io.listFiles().map((f) => [f.path, f]));
    const notes = new Map<string, { text: string; embeds: Map<string, string>; missing: string[] }>();
    for (const note of sources.filter((s) => s.kind === "markdown")) {
      const text = await this.io.read(note.path);
      const embeds = new Map<string, string>();
      const missing: string[] = [];
      for (const e of embedsOf(text)) {
        const target = this.io.resolveLink(e.link, note.path);
        if (!target) {
          if (VIEW_EXT.has(extname(e.link)) || extname(e.link) === "pdf") missing.push(e.link);
          continue;
        }
        // A photo that belongs to another course is only referenced: it stays (and is synthesised) there.
        if (this.otherCourse(target, lot.space.folder)) continue;
        const kind = sourceKind(target, stats.get(target)?.size ?? 0);
        if (kind !== "image" && kind !== "pdf") continue;
        let child = sources.find((s) => s.path === target);
        if (!child) {
          const st = stats.get(target);
          child = { id: `S${sources.length + 1}`, path: target, kind, size: st?.size ?? 0, mtime: st?.mtime ?? 0, embeddedIn: note.id };
          sources.push(child);
        } else if (!child.embeddedIn && child.id !== note.id) child.embeddedIn = note.id;
        embeds.set(e.raw, child.id);
      }
      notes.set(note.id, { text, embeds, missing });
    }
    return { sources, notes };
  }

  async extract(lot: Lot, progress: Progress, signal?: AbortSignal): Promise<{ sources: Source[]; extracts: Map<string, Extract> }> {
    const { sources, notes } = await this.collect(lot);
    const extracts = new Map<string, Extract>();
    const todo: Source[] = [];
    for (const s of sources) {
      const note = notes.get(s.id);
      if (note) {
        // Notes are read as they are, with the place and source of each embedded photo marked.
        const uncertain = note.missing.map((m) => `image insérée introuvable dans le vault : ${m}`);
        extracts.set(s.id, { sourceId: s.id, path: s.path, text: annotateEmbeds(note.text, note.embeds), uncertain, description: note.embeds.size ? `note contenant ${note.embeds.size} photo(s)/document(s) inséré(s)` : "" });
        continue;
      }
      if (s.kind === "text" || s.kind === "notebook" || s.kind === "data" || s.kind === "other") {
        extracts.set(s.id, await this.extractOne(s, signal));
        continue;
      }
      const cached = await this.io.cacheRead(cacheKey(s));
      if (cached) extracts.set(s.id, { ...(JSON.parse(cached) as Extract), sourceId: s.id, path: s.path });
      else todo.push(s);
    }
    let done = 0;
    const total = todo.length;
    if (total) progress(`Lecture intégrale de ${total} document(s)…`, 0, total);
    const errors: string[] = [];
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(this.settings.concurrency, total)) }, async () => {
      while (next < todo.length) {
        const s = todo[next++];
        signal?.throwIfAborted();
        try {
          const e = await this.extractOne(s, signal);
          extracts.set(s.id, e);
          await this.io.cacheWrite(cacheKey(s), JSON.stringify(e));
        } catch (err) {
          if (signal?.aborted) throw err;
          errors.push(`${basename(s.path)} : ${(err as Error).message}`);
        }
        progress(`Lecture intégrale des documents…`, ++done, total);
      }
    });
    await Promise.all(workers);
    if (errors.length) progress(`${errors.length} document(s) illisible(s) : ${errors[0]}`);
    return { sources, extracts };
  }

  private async extractOne(s: Source, signal?: AbortSignal): Promise<Extract> {
    const base = { sourceId: s.id, path: s.path, uncertain: [] as string[], description: "" };
    if (s.kind === "markdown" || s.kind === "text") return { ...base, text: await this.io.read(s.path) };
    if (s.kind === "notebook") return { ...base, text: notebookText(await this.io.read(s.path)), description: "notebook Jupyter (cellules et sorties texte)" };
    if (s.kind === "data") {
      const readable = ["csv", "tsv", "txt", "json", "dat"].includes(extname(s.path)) && s.size < 20 * 1024 * 1024;
      const text = readable ? dataPreview((await this.io.read(s.path)).slice(0, 20000), s.size) : `Fichier de données (${Math.round(s.size / 1024)} Ko, .${extname(s.path)}), non lu.`;
      return { ...base, text, description: "fichier de données", survey: true };
    }
    if (s.kind === "image") return this.extractPhoto(s, signal);
    if (s.kind === "pdf") return this.extractPdf(s, signal);
    return { ...base, text: `(format non lu automatiquement : .${extname(s.path)} — à intégrer à la main)`, description: "document non lu" };
  }

  private async extractPhoto(s: Source, signal?: AbortSignal): Promise<Extract> {
    const backend = this.engine.backend();
    const readsFiles = backend.name === "Claude Code";
    const views = await this.io.imageViews(s.path);
    const attachments: Attachment[] = views.map((v) => ({
      path: `${s.path} (${v.label})`,
      absPath: v.absPath,
      kind: "image",
      load: async () => ({ mediaType: v.mediaType, base64: v.base64 }),
    }));
    const labels = views.map((v) => v.label);
    const prior = await this.priorTranscription(s.path);
    const draft = await backend.complete<PhotoAnswer>({
      label: `transcription de ${basename(s.path)}`,
      system: photoSystem(this.settings),
      prompt: photoPrompt(s.path, labels, readsFiles, prior),
      schema: PHOTO_SCHEMA,
      model: this.settings.transcriptionModel,
      effort: "high",
      attachments,
      maxTokens: 16000,
      signal,
    });
    let text = draft.transcript;
    let uncertain = draft.uncertain ?? [];
    if (this.settings.verifyTranscriptions) {
      const checked = await backend.complete<VerifyAnswer>({
        label: `vérification de ${basename(s.path)}`,
        system: verifySystem(this.settings),
        prompt: verifyPrompt(s.path, labels, draft.transcript, readsFiles),
        schema: VERIFY_SCHEMA,
        model: this.settings.transcriptionModel,
        effort: "medium",
        attachments,
        maxTokens: 16000,
        signal,
      });
      text = checked.transcript || text;
      uncertain = checked.uncertain ?? uncertain;
    }
    return { sourceId: s.id, path: s.path, text, uncertain, description: draft.description ?? "" };
  }

  /** A transcription an older version wrote for this photo ("<photo> — transcription.md"), used as a draft to check. */
  private async priorTranscription(photo: string): Promise<string | null> {
    const stem = basename(photo).replace(/\.[^.]+$/, "");
    const note = this.io.listFiles().find((f) => basename(f.path) === `${stem} — transcription.md`);
    if (!note) return null;
    const text = (await this.io.read(note.path)).replace(/^!\[\[[^\]]*\]\]\s*$/gm, "").trim();
    return text || null;
  }

  private async extractPdf(s: Source, signal?: AbortSignal): Promise<Extract> {
    const backend = this.engine.backend();
    const readsFiles = backend.name === "Claude Code";
    // Lecture slides are read in full, however long; references only up to a few dozen pages.
    const limit = REFERENCE_FOLDER.test(s.path) || REFERENCE_NAME.test(basename(s.path)) ? REFERENCE_PAGES : this.settings.maxPdfPages;
    const layer = await this.io.pdfText(s.path, limit);
    const pageCount = layer?.pageCount || 1;
    const pages = layer ? splitPages(layer.text) : new Map<number, string>();
    if (pageCount > limit) {
      // A textbook, a lecture-notes volume, a Moodle dump: skimmed (first pages, table of contents), kept as a reference.
      const head = [...pages].filter(([n]) => n <= SURVEY_PAGES).map(([n, t]) => `[page ${n}] ${t}`).join("\n").slice(0, 12000);
      return {
        sourceId: s.id,
        path: s.path,
        text: head || "(pas de texte extractible)",
        uncertain: [],
        description: `${pageCount} pages — document long, seulement survolé (premières pages)`,
        truncated: `document de ${pageCount} pages, au-delà de la limite de lecture intégrale (${limit} pages) : document de référence`,
        survey: true,
      };
    }
    const last = Math.min(pageCount, limit);
    const parts: string[] = [];
    const uncertain: string[] = [];
    const attachment: Attachment = { path: s.path, absPath: this.io.absolutePath(s.path), kind: "pdf", load: () => this.io.binaryPayload(s.path) };
    for (let from = 1; from <= last; from += PDF_CHUNK) {
      const to = Math.min(last, from + PDF_CHUNK - 1);
      const hint = [...pages].filter(([n]) => n >= from && n <= to).map(([n, t]) => `[page ${n}] ${t}`).join("\n") || null;
      const answer = await backend.complete<PdfAnswer>({
        label: `lecture de ${basename(s.path)} (p. ${from}-${to})`,
        system: pdfSystem(this.settings),
        prompt: pdfPrompt(s.path, from, to, pageCount, hint, readsFiles),
        schema: PDF_SCHEMA,
        model: this.settings.digestModel,
        effort: "medium",
        attachments: [attachment],
        maxTokens: 32000,
        signal,
      });
      parts.push(answer.text);
      uncertain.push(...(answer.uncertain ?? []));
    }
    const truncated = pageCount > last ? `pages ${last + 1} à ${pageCount} non lues (limite de ${last} pages)` : null;
    return { sourceId: s.id, path: s.path, text: parts.join("\n\n"), uncertain, description: `${pageCount} page(s)`, truncated };
  }

  /** Saves a transcription corrected by the user, so it is reused (and never re-read) afterwards. */
  async correct(job: SynthesisJob, sourceId: string, text: string) {
    const s = job.sources.find((x) => x.id === sourceId);
    const e = job.extracts.get(sourceId);
    if (!s || !e) return;
    const next = { ...e, text, editedByUser: true };
    job.extracts.set(sourceId, next);
    await this.io.cacheWrite(cacheKey(s), JSON.stringify(next));
  }

  // -------------------------------------------------------------------------
  // 3-4. Plan and revisions

  async plan(lot: Lot, progress: Progress, signal?: AbortSignal): Promise<SynthesisJob> {
    // Lots are prepared ahead (a whole course, session by session): an earlier session may have moved
    // files since, so the course is read again and what is gone is dropped.
    lot.space = this.engine.space(lot.space.folder) ?? lot.space;
    lot.files = lot.files.filter((f) => this.io.exists(f.path));
    const { sources, extracts } = await this.extract(lot, progress, signal);
    const map = await this.engine.readMap(lot.space);
    const course = await this.courseContext(lot.space, map);
    progress(`Analyse et plan des fiches pour « ${lot.name} »…`);
    const request = { system: planSystem(this.settings), prompt: planPrompt(course, lot.name, sources, extracts) };
    const plan = await this.engine.backend().complete<SynthesisPlan>({
      label: `plan de synthèse pour ${lot.name}`,
      ...request,
      schema: PLAN_SCHEMA,
      model: this.settings.planModel,
      effort: "high",
      maxTokens: 32000,
      signal,
    });
    return await this.prepare({ lot, sources, extracts, course, map, plan, request, round: 1, history: [], unassigned: [], written: [], coverage: [] });
  }

  async revise(job: SynthesisJob, feedback: SynthesisFeedback, progress: Progress, signal?: AbortSignal): Promise<SynthesisJob> {
    for (const t of feedback.transcriptions) await this.correct(job, t.sourceId, t.text);
    const text = feedbackText(job, feedback);
    progress(`Révision du plan (version ${job.round + 1})…`);
    // The sources block is rebuilt so corrected transcriptions are what Claude reads.
    const original = planPrompt(job.course, job.lot.name, job.sources, job.extracts);
    const plan = await this.engine.backend().complete<SynthesisPlan>({
      label: `révision du plan de synthèse pour ${job.lot.name}`,
      system: job.request.system,
      prompt: planRevisionPrompt(original, job.plan, job.round, text, job.history),
      schema: PLAN_SCHEMA,
      model: this.settings.planModel,
      effort: "high",
      maxTokens: 32000,
      signal,
    });
    return await this.prepare({ ...job, plan, request: { ...job.request, prompt: original }, round: job.round + 1, history: [...job.history, text || "(aucun commentaire)"], written: [], coverage: [] });
  }

  /** Makes Claude's plan safe: paths inside the course, unique ids, every source accounted for. */
  private async prepare(job: SynthesisJob): Promise<SynthesisJob> {
    const space = job.lot.space;
    const inSpace = (p: string) => {
      const clean = sanitizePath(p);
      return isInside(clean, space.folder) ? clean : join(space.folder, clean);
    };
    const plan = job.plan;
    // A session folder ("02 Nearest Neighbors") stays the session: its notes go to <session>/Fiches,
    // its sources to <session>/Sources; the course has one skill tree, reshaped around them.
    const sessionFolder = job.lot.folder && job.lot.folder !== space.folder ? job.lot.folder : null;
    plan.module.folder = sessionFolder ?? inSpace(plan.module.folder || plan.module.title);
    plan.language = this.settings.ficheLanguage === "en" ? "English" : this.settings.ficheLanguage === "fr" ? "français" : plan.language || job.map?.language || "";
    const fichesDir = this.fichesDir(plan.module.folder);
    const seen = new Set<string>();
    const existingIds = new Set(job.map ? allSections(job.map).map((s) => s.id) : []);
    // Existing notes placed in the tree as they are must exist, and be documents of this lot: notes elsewhere
    // in the course are placed when their own folder is synthesised, in the module of that folder.
    const lotPaths = new Set(job.sources.map((x) => x.path));
    plan.fiches = plan.fiches.filter((f) => f.action !== "keep" || (f.path && lotPaths.has(inSpace(f.path)) && this.io.exists(inSpace(f.path))));
    for (const f of plan.fiches) {
      let id = slugify(f.id || f.title) || "fiche";
      while (seen.has(id) || (f.action === "create" && existingIds.has(id))) id = `${id}-b`;
      seen.add(id);
      f.id = id;
      delete f.moveFrom;
      if (f.action === "keep") f.path = inSpace(f.path);
      if (f.action === "extend") {
        f.path = inSpace(f.path || "");
        if (extname(f.path) !== "md") f.path = `${f.path}.md`;
        if (!this.io.exists(f.path)) f.action = "create";
        // A note an older version of the plug-in wrote at the session root joins the notes folder.
        // Notes the user organised elsewhere stay where they are.
        else if (dirname(f.path) === plan.module.folder && writtenByPlugin(await this.io.read(f.path))) f.moveFrom = f.path;
      }
      f.outline = f.outline ?? [];
      f.sources = (f.sources ?? []).filter((x) => job.sources.some((s) => s.id === x.sourceId));
      // The photos of a note go with it: the note alone is only links.
      for (const x of [...f.sources]) {
        for (const child of job.sources.filter((s) => s.embeddedIn === x.sourceId)) {
          if (!f.sources.some((y) => y.sourceId === child.id)) f.sources.push({ sourceId: child.id, what: `photo insérée dans ${x.sourceId}` });
        }
      }
      f.dependsOn = f.dependsOn ?? [];
      f.keywords = f.keywords ?? [];
    }
    // Every document gets a disposition. A note the plan keeps or extends is a note, not a source; what was
    // only skimmed is a reference; notebooks and data are never transcribed; embedded photos always are.
    const given = new Map((plan.sources ?? []).map((x) => [x.sourceId, x]));
    const notes = new Set(plan.fiches.filter((f) => f.action !== "create").map((f) => f.moveFrom ?? f.path));
    plan.sources = job.sources.map((src) => {
      const g = given.get(src.id);
      const e = job.extracts.get(src.id);
      const asked = g?.disposition ?? "integrate";
      let disposition: Disposition = asked;
      if (notes.has(src.path)) disposition = "note";
      else if (src.embeddedIn) disposition = "integrate";
      else if (e?.survey && src.kind !== "data") disposition = asked === "ignore" ? "ignore" : "reference";
      else if (src.kind === "notebook" || src.kind === "data" || src.kind === "other") disposition = asked === "integrate" ? "keep" : asked;
      return { sourceId: src.id, role: g?.role ?? "", contributes: g?.contributes ?? "", disposition };
    });
    // A note kept or extended is not a source of the other notes.
    for (const f of plan.fiches) f.sources = f.sources.filter((x) => this.dispositionIn(plan, x.sourceId) !== "note" || f.action === "extend");
    this.numberFiches(plan, fichesDir);
    plan.tree = { moduleOrder: plan.tree?.moduleOrder ?? [], updates: (plan.tree?.updates ?? []).filter((u) => u.id && !plan.fiches.some((f) => f.id === u.id)) };
    const used = new Set(plan.fiches.flatMap((f) => f.sources.map((x) => x.sourceId)));
    job.unassigned = job.sources.filter((s) => !used.has(s.id) && this.disposition(job, s.id) === "integrate").map((s) => s.id);
    plan.questions = plan.questions ?? [];
    plan.changes = plan.changes ?? [];
    plan.issues = plan.issues ?? [];
    plan.preferences = plan.preferences ?? [];
    return job;
  }

  fichesDir(sessionFolder: string) {
    return join(sessionFolder, this.settings.fichesFolder);
  }
  sourcesDir(sessionFolder: string) {
    return join(sessionFolder, this.settings.sourcesFolder);
  }

  /**
   * Notes are numbered in learning order inside the notes folder ("01 - Distances and norms.md"):
   * notes already there keep their name, new ones (and moved ones) follow.
   */
  private numberFiches(plan: SynthesisPlan, fichesDir: string) {
    const staying = new Set(plan.fiches.filter((f) => f.action === "keep" || (f.action === "extend" && !f.moveFrom)).map((f) => f.path));
    const numberOf = (p: string) => Number(/^(\d+)/.exec(basename(p))?.[1] ?? 0);
    const present = this.io.listFiles().filter((f) => dirname(f.path) === fichesDir && extname(f.path) === "md");
    let n = Math.max(0, ...present.map((f) => numberOf(f.path)));
    const taken = new Set(present.map((f) => f.path));
    for (const f of plan.fiches) {
      if (staying.has(f.path)) continue;
      const title = sanitizeSegment(f.title.replace(/^\s*\d+\s*[-–.)]\s*/, "")).replace(/[\\/]/g, "-") || f.id;
      let path: string;
      do path = join(fichesDir, `${String(++n).padStart(2, "0")} - ${title}.md`);
      while (taken.has(path));
      taken.add(path);
      f.path = path;
    }
  }

  disposition(job: SynthesisJob, sourceId: string): Disposition {
    return this.dispositionIn(job.plan, sourceId);
  }
  private dispositionIn(plan: SynthesisPlan, sourceId: string): Disposition {
    return plan.sources.find((x) => x.sourceId === sourceId)?.disposition ?? "integrate";
  }

  private async courseContext(space: SpaceInventory, map: SpaceMap | null): Promise<CourseContext> {
    const lines: string[] = [];
    if (map) {
      for (const sec of map.sections) {
        lines.push(`- module ${sec.id} « ${sec.title} »${sec.folder ? ` (dossier ${sec.folder})` : ""}${sec.dependsOn.length ? ` après ${sec.dependsOn.join(", ")}` : ""}`);
        for (const c of sec.children) {
          const fiche = c.resources.find((r) => r.role === "fiche");
          const headings = fiche && this.io.exists(fiche.path) ? headingsOf(await this.io.read(fiche.path)) : "";
          lines.push(`    - fiche ${c.id} « ${c.title} »${fiche ? ` : ${fiche.path}` : ""}${c.dependsOn.length ? ` (prérequis : ${c.dependsOn.join(", ")})` : ""}${headings ? ` — sections : ${headings}` : ""}`);
        }
        for (const r of sec.resources.filter((r) => r.role !== "archive")) lines.push(`    - document : ${r.path}`);
      }
    }
    // Notes of the course not in the map yet (e.g. written by hand or by an older version).
    const listed = new Set(map ? allSections(map).flatMap((s) => s.resources.map((r) => r.path)) : []);
    const loose = space.files.filter((f) => fileKind(f.path) === "markdown" && !listed.has(f.path)).slice(0, 60);
    if (loose.length) {
      lines.push("Autres notes du cours (écrites à la main ou par une version précédente ; à compléter plutôt que dupliquer) :");
      for (const [i, f] of loose.entries()) {
        const headings = i < 40 ? headingsOf(await this.io.read(f.path)) : "";
        lines.push(`    - ${f.path}${headings ? ` — sections : ${headings}` : ""}`);
      }
    }
    const programme = this.programmeOf(space.folder);
    const instructions = [programme?.instructions ? `(pour l'ensemble des cours) ${programme.instructions}` : "", space.config.instructions].filter(Boolean).join("\n");
    return {
      course: space.name,
      folder: space.folder,
      outline: lines.join("\n"),
      conventions: map?.conventions ?? "",
      preferences: map?.preferences ?? [],
      instructions,
    };
  }

  // -------------------------------------------------------------------------
  // 5-6. Writing and coverage

  /** Where the lot's sources and its archive document will live. */
  archiveLayout(job: SynthesisJob) {
    const dir = this.sourcesDir(job.plan.module.folder);
    const taken = new Set<string>();
    const target = new Map<string, string>();
    for (const s of job.sources) {
      // Notebooks and their data keep their relative layout, so the notebook still finds its files.
      const keepTree = (s.kind === "notebook" || s.kind === "data") && job.lot.folder && isInside(s.path, job.lot.folder);
      const rel = keepTree ? relativeTo(s.path, job.lot.folder!) : basename(s.path);
      const p = uniquePath(join(dir, rel), (x) => taken.has(x) || (this.io.exists(x) && x !== s.path));
      taken.add(p);
      target.set(s.id, p);
    }
    const doc = uniquePath(join(dir, `Transcriptions — ${sanitizeSegment(job.plan.session || job.lot.name).replace(/[\\/]/g, "-")}.md`), (x) => this.io.exists(x));
    return { dir, target, doc };
  }

  async write(job: SynthesisJob, progress: Progress, signal?: AbortSignal, comments = new Map<string, string>()): Promise<SynthesisJob> {
    const layout = this.archiveLayout(job);
    const fiches = job.plan.fiches.filter((f) => f.action !== "keep");
    if (!fiches.length) {
      job.written = [];
      await this.checkCoverage(job, progress, signal);
      return job;
    }
    const written: WrittenFiche[] = new Array(fiches.length);
    let done = 0;
    let next = 0;
    progress("Rédaction des fiches…", 0, fiches.length);
    const workers = Array.from({ length: Math.max(1, Math.min(this.settings.concurrency, fiches.length)) }, async () => {
      while (next < fiches.length) {
        const i = next++;
        written[i] = await this.writeOne(job, fiches[i], layout, comments.get(fiches[i].id) ?? "", signal);
        progress("Rédaction des fiches…", ++done, fiches.length);
      }
    });
    await Promise.all(workers);
    job.written = written;
    await this.checkCoverage(job, progress, signal);
    return job;
  }

  /** Rewrites one note with a comment from the user, then re-checks coverage. */
  async rewrite(job: SynthesisJob, ficheId: string, comment: string, progress: Progress, signal?: AbortSignal): Promise<SynthesisJob> {
    const i = job.written.findIndex((w) => w.plan.id === ficheId);
    if (i < 0) return job;
    progress(`Réécriture de « ${job.written[i].plan.title} »…`);
    const current = job.written[i];
    const comm = `${comment}\n\nVersion actuelle de la fiche, à améliorer selon cette demande :\n\`\`\`markdown\n${current.content}\n\`\`\``;
    job.written[i] = await this.writeOne(job, current.plan, this.archiveLayout(job), comm, signal);
    await this.checkCoverage(job, progress, signal);
    return job;
  }

  private async writeOne(job: SynthesisJob, fiche: FichePlan, layout: ReturnType<Synthesizer["archiveLayout"]>, comment: string, signal?: AbortSignal): Promise<WrittenFiche> {
    const before = fiche.action === "extend" ? await this.io.read(fiche.moveFrom ?? fiche.path) : null;
    const used = job.sources.filter((s) => fiche.sources.some((x) => x.sourceId === s.id));
    const others = [
      ...job.plan.fiches.filter((f) => f.id !== fiche.id).map((f) => ({ title: f.title, path: f.path })),
      ...(job.map ? allSections(job.map).flatMap((s) => s.resources.filter((r) => r.role === "fiche").map((r) => ({ title: r.label, path: r.path }))) : []),
    ];
    const links = [{ path: layout.doc, title: `Sources de la séance (${job.plan.session || job.lot.name})` }, ...used.filter((s) => s.kind !== "image").map((s) => ({ path: this.finalPath(job, layout, s), title: basename(s.path) }))];
    const frontmatter = [
      "curator: fiche",
      `cours: "${job.course.course.replace(/"/g, "'")}"`,
      `module: "${job.plan.module.title.replace(/"/g, "'")}"`,
      `notions: [${fiche.keywords.map((k) => `"${k.replace(/"/g, "'")}"`).join(", ")}]`,
      `sources: "[[${layout.doc}]]"`,
    ].join("\n");
    const answer = await this.engine.backend().complete<WriteAnswer>({
      label: `rédaction de « ${fiche.title} »`,
      system: writeSystem(this.settings),
      prompt: writePrompt(fiche, frontmatter, before, used, job.extracts, others, links, comment, job.plan.language),
      schema: WRITE_SCHEMA,
      model: this.settings.planModel,
      effort: "high",
      maxTokens: 32000,
      signal,
    });
    let content = answer.content.trim();
    if (!content.startsWith("---")) content = `---\n${frontmatter}\n---\n\n${content}`;
    return { plan: fiche, content: `${content}\n`, before };
  }

  /** Checks that nothing of the sources is lost; adds what is missing (one round), then re-checks. */
  private async checkCoverage(job: SynthesisJob, progress: Progress, signal?: AbortSignal) {
    // Notes being extended are sources too: their current content must survive.
    const extended = job.written.filter((w) => w.before !== null);
    const pseudo: Source[] = extended.map((w, i) => ({ id: `E${i + 1}`, path: w.plan.path, kind: "markdown", size: 0, mtime: 0 }));
    const extracts = new Map(job.extracts);
    extended.forEach((w, i) => extracts.set(`E${i + 1}`, { sourceId: `E${i + 1}`, path: w.plan.path, text: w.before!, uncertain: [], description: "contenu actuel de la fiche" }));
    const integrate = job.sources.filter((s) => this.disposition(job, s.id) === "integrate" && s.kind !== "other");
    // A note that is only photos ("Photos CM" = ![[IMG…]]![[IMG…]]) has no content of its own: it is
    // covered when its photos are, without asking Claude about it.
    const container = (s: Source) =>
      s.kind === "markdown" && job.sources.some((c) => c.embeddedIn === s.id) && !(job.extracts.get(s.id)?.text ?? "").replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)|⟨[^⟩]*⟩/g, "").trim();
    const readable = integrate.filter((s) => job.extracts.has(s.id) && !container(s));
    const all = [...readable, ...pseudo];
    const keepEntry = (s: Source): Coverage => ({ sourceId: s.id, path: s.path, covered: true, kept: true, missing: [] });

    if (!job.written.length) {
      job.coverage = [
        ...job.sources.filter((s) => this.disposition(job, s.id) !== "integrate").map(keepEntry),
        ...integrate.map((s) => ({ sourceId: s.id, path: s.path, covered: false, missing: [{ item: "aucune fiche ne reprend ce document", fiche: "" }] })),
      ];
      return;
    }

    const run = async (subset: Source[]) => {
      const answer = await this.engine.backend().complete<CoverageAnswer>({
        label: "contrôle de couverture",
        system: coverageSystem(this.settings),
        prompt: coveragePrompt(subset, extracts, job.written.map((w) => ({ path: w.plan.path, content: w.content }))),
        schema: COVERAGE_SCHEMA,
        model: this.settings.planModel,
        effort: "medium",
        maxTokens: 16000,
        signal,
      });
      return answer.sources ?? [];
    };

    progress("Contrôle : tout le contenu des sources est-il dans les fiches ?");
    let result = await run(all);
    const missing = result.filter((r) => !r.covered && r.missing.length);
    if (missing.length) {
      // Group the missing elements by note and complete each note once.
      const paths = job.written.map((w) => w.plan.path);
      const byFiche = new Map<string, { sourceId: string; items: string[] }[]>();
      for (const r of missing) {
        for (const m of r.missing) {
          const target = matchPath(m.fiche, paths) ?? job.written.find((w) => w.plan.sources.some((x) => x.sourceId === r.sourceId))?.plan.path ?? paths[0];
          const list = byFiche.get(target) ?? [];
          const entry = list.find((e) => e.sourceId === r.sourceId) ?? (list.push({ sourceId: r.sourceId, items: [] }), list[list.length - 1]);
          entry.items.push(m.item);
          byFiche.set(target, list);
        }
      }
      let k = 0;
      for (const [path, items] of byFiche) {
        progress(`Ajout des éléments manquants…`, ++k, byFiche.size);
        const w = job.written.find((x) => x.plan.path === path)!;
        const answer = await this.engine.backend().complete<WriteAnswer>({
          label: `complément de « ${w.plan.title} »`,
          system: completeSystem(this.settings),
          prompt: completePrompt(path, w.content, items, all, extracts),
          schema: WRITE_SCHEMA,
          model: this.settings.planModel,
          effort: "high",
          maxTokens: 32000,
          signal,
        });
        if (answer.content?.trim()) w.content = keepFrontmatter(w.content, answer.content);
      }
      progress("Nouveau contrôle de couverture…");
      const again = await run(all.filter((s) => missing.some((m) => m.sourceId === s.id)));
      result = result.map((r) => again.find((a) => a.sourceId === r.sourceId) ?? r);
    }
    job.coverage = all.map((s) => {
      const r = result.find((x) => x.sourceId === s.id);
      const covered = !job.unassigned.includes(s.id) && (r ? r.covered || !r.missing.length : false);
      return { sourceId: s.id, path: s.path, covered, missing: r?.missing ?? [] };
    });
    for (const s of integrate.filter((x) => !job.extracts.has(x.id))) job.coverage.push({ sourceId: s.id, path: s.path, covered: false, missing: [{ item: "document illisible : pas de transcription", fiche: "" }] });
    for (const s of integrate.filter(container)) job.coverage.push({ sourceId: s.id, path: s.path, covered: true, missing: [] });
    // A note of photos is archived only with all its photos: otherwise the photos would be orphaned.
    for (const c of job.coverage) {
      const children = job.sources.filter((s) => s.embeddedIn === c.sourceId && this.disposition(job, s.id) === "integrate");
      const open = children.filter((ch) => !job.coverage.find((x) => x.sourceId === ch.id)?.covered);
      if (c.covered && open.length) {
        c.covered = false;
        c.missing.push({ item: `photo(s) pas entièrement intégrée(s) : ${open.map((o) => o.id).join(", ")}`, fiche: "" });
      }
    }
    for (const s of job.sources.filter((x) => this.disposition(job, x.id) !== "integrate")) job.coverage.push(keepEntry(s));
  }

  // -------------------------------------------------------------------------
  // 7. Apply

  async apply(job: SynthesisJob, progress: Progress): Promise<SynthesisReport> {
    const space = job.lot.space;
    const layout = this.archiveLayout(job);
    const entry: JournalEntry = {
      id: `${Date.now()}`,
      date: new Date().toISOString(),
      label: `Synthèse — ${job.plan.session || job.lot.name}`,
      steps: [],
      mapsBefore: { [space.folder]: job.map },
    };
    const report: SynthesisReport = { fiches: [], archived: [], kept: [], pending: [], untouched: [], archiveDoc: "", canvas: space.generated.canvas, moved: {} };
    const steps: JournalStep[] = entry.steps;
    const coveredIds = new Set(job.coverage.filter((c) => c.covered && !c.kept && c.sourceId.startsWith("S")).map((c) => c.sourceId));
    const move = async (from: string, to: string) => {
      await this.engine.mkdirp(dirname(to), steps);
      await this.io.move(from, to);
      steps.push({ type: "move", from, to });
    };

    await this.engine.asPlugin(async () => {
      try {
        // Outputs: the notes, in <session>/Fiches.
        if (job.written.length) await this.engine.mkdirp(this.fichesDir(job.plan.module.folder), steps);
        for (const [i, w] of job.written.entries()) {
          progress("Écriture des fiches…", i, job.written.length);
          if (w.before === null) {
            const path = uniquePath(w.plan.path, (p) => this.io.exists(p));
            w.plan.path = path;
            await this.engine.writeTracked(path, w.content, steps);
          } else {
            const from = w.plan.moveFrom ?? w.plan.path;
            const current = await this.io.read(from);
            if (current !== w.before) throw new Error(`« ${from} » a changé depuis la préparation : relance la synthèse.`);
            if (w.plan.moveFrom) {
              w.plan.path = uniquePath(w.plan.path, (p) => this.io.exists(p));
              await move(from, w.plan.path);
            }
            await this.engine.writeTracked(w.plan.path, w.content, steps);
          }
          report.fiches.push(w.plan.path);
        }

        // Inputs: the transcriptions document, then the raw documents, in <session>/Sources.
        if (coveredIds.size) {
          await this.engine.writeTracked(layout.doc, this.archiveDocument(job, layout, coveredIds), steps);
          report.archiveDoc = layout.doc;
        }
        for (const src of job.sources) {
          const disposition = this.disposition(job, src.id);
          if (disposition === "note" || disposition === "ignore") {
            report.untouched.push(src.path);
            continue;
          }
          const keep = disposition !== "integrate";
          if (!this.io.exists(src.path) || (!keep && !coveredIds.has(src.id))) {
            (keep ? report.kept : report.pending).push(src.path);
            continue;
          }
          const to = this.finalPath(job, layout, src);
          if (to !== src.path) {
            await move(src.path, to);
            report.moved[src.path] = to;
          }
          (keep ? report.kept : report.archived).push(src.path);
        }

        // What an older version generated for this folder (its own dashboard, index and map) is retired.
        if (job.lot.folder && job.lot.folder !== space.folder) {
          const nested = this.settings.spaces.find((x) => x.folder === job.lot.folder);
          if (nested) {
            for (const p of [nested.canvas, nested.index, mapPath(nested.folder)]) {
              if (!this.io.exists(p)) continue;
              await move(p, uniquePath(join(layout.dir, "Anciens tableaux de bord", basename(p)), (x) => this.io.exists(x)));
            }
            this.settings.spaces = this.settings.spaces.filter((x) => x !== nested);
          }
        }
        // What an older version wrote at the session root and the new notes replace — its notes, its
        // canvases (week dashboards, 0.6 session canvas) — goes to Sources, out of the way.
        const sessionFolder = job.lot.folder && job.lot.folder !== space.folder ? job.lot.folder : null;
        for (const f of sessionFolder ? this.io.listFiles().filter((x) => dirname(x.path) === sessionFolder) : []) {
          if (report.fiches.includes(f.path) || report.moved[f.path]) continue;
          const ext = extname(f.path);
          const head = ext === "md" || ext === "canvas" ? await this.io.read(f.path) : "";
          const oldNote = ext === "md" && writtenByPlugin(head);
          const oldCanvas = ext === "canvas" && /"id":\s*"cc-/.test(head);
          if (!oldNote && !oldCanvas) continue;
          const to = uniquePath(join(layout.dir, oldNote ? "Anciennes fiches" : "Anciens tableaux de bord", basename(f.path)), (x) => this.io.exists(x));
          await move(f.path, to);
          report.moved[f.path] = to;
        }
        await this.engine.removeEmptied(
          Object.keys(report.moved).map((p, index) => ({ kind: "move", source: p, target: null, content: null, reason: "", index, error: null })),
          space.folder,
          steps,
        );

        // The course skill tree, reshaped and completed.
        const map = this.updateMap(job, layout, report);
        const live = this.engine.space(space.folder) ?? space;
        await this.engine.writeTracked(live.generated.map, JSON.stringify(map, null, 2), steps);
        await this.engine.renderDashboards(live, map, { keepLayout: true }, steps);
        report.canvas = live.generated.canvas;

        // Ledger: the notes are known; so are the lot's documents left in place (not proposed again
        // until they change). Other raw documents of the course stay "new" until they are synthesised.
        const ledger = this.engine.data.ledger;
        const done = new Set([...report.fiches, ...report.kept.map((p) => report.moved[p] ?? p), ...report.pending, ...report.untouched]);
        for (const f of this.engine.space(space.folder)?.files ?? []) {
          if (done.has(f.path)) ledger[f.path] = { ...(ledger[f.path] ?? {}), fp: `${f.size}:${Math.round(f.mtime)}`, known: true };
        }
      } finally {
        await this.engine.record(entry);
      }
    });
    return report;
  }

  /**
   * Where a source ends up: integrated documents go to the session's sources folder; documents kept
   * on purpose too when they belong to the session folder (a course-wide syllabus stays where it is).
   */
  private finalPath(job: SynthesisJob, layout: ReturnType<Synthesizer["archiveLayout"]>, src: Source): string {
    if (isInside(src.path, layout.dir)) return src.path;
    const disposition = this.disposition(job, src.id);
    if (disposition === "reference" || disposition === "note" || disposition === "ignore") return src.path;
    const keep = disposition === "keep";
    if (keep && !(job.lot.folder && job.lot.folder !== job.lot.space.folder && isInside(src.path, job.lot.folder))) return src.path;
    return layout.target.get(src.id)!;
  }

  private archiveDocument(job: SynthesisJob, layout: ReturnType<Synthesizer["archiveLayout"]>, covered: Set<string>): string {
    const lines = [
      "---",
      "curator: archive",
      `cours: "${job.course.course.replace(/"/g, "'")}"`,
      `seance: "${(job.plan.session || job.lot.name).replace(/"/g, "'")}"`,
      "---",
      `# ${job.plan.session || job.lot.name} — sources archivées`,
      "",
      job.plan.summary,
      "",
      `Fiches produites : ${job.written.map((w) => `[[${w.plan.path}|${w.plan.title}]]`).join(" · ")}`,
      "",
    ];
    for (const s of job.sources) {
      const e = job.extracts.get(s.id);
      const archived = covered.has(s.id);
      const where = archived ? layout.target.get(s.id)! : s.path;
      const parent = s.embeddedIn ? job.sources.find((x) => x.id === s.embeddedIn) : null;
      lines.push(`## ${s.id} — ${basename(s.path)}`);
      if (archived) lines.push(`Archivé depuis \`${s.path}\`${parent ? ` (photo insérée dans ${parent.id}, ${basename(parent.path)})` : ""}.`);
      else if (this.disposition(job, s.id) !== "integrate") lines.push(`Non transcrit (${this.disposition(job, s.id)}) : [[${this.finalPath(job, layout, s)}]].`);
      else lines.push(`> [!warning] Non archivé (contenu pas entièrement intégré) : reste à \`${s.path}\`.`);
      if (s.kind === "image") lines.push("", `![[${where}]]`);
      else lines.push("", `[[${where}|Ouvrir l'original]]`);
      if (e?.description) lines.push("", `*${e.description}*`);
      if (e?.uncertain.length) lines.push("", `> [!question] Passages incertains\n${e.uncertain.map((u) => `> - ${u}`).join("\n")}`);
      if (e?.text && s.kind !== "markdown") lines.push("", "### Transcription", "", e.text);
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  private updateMap(job: SynthesisJob, layout: ReturnType<Synthesizer["archiveLayout"]>, report: SynthesisReport): SpaceMap {
    const space = job.lot.space;
    const map: SpaceMap = job.map
      ? structuredClone(job.map)
      : {
          version: 2,
          name: space.name,
          folder: space.folder,
          kind: "cours",
          summary: "",
          purpose: "",
          usage: "",
          conventions: "",
          preferences: [],
          dashboardTitle: "Skill tree",
          linkKind: "prerequisite",
          sections: [],
          transverse: [],
          // Skill trees or dashboards the user made for this course stay, linked from ours.
          keptDashboards: (this.engine.space(space.folder) ?? space).files.map((f) => f.path).filter((p) => fileKind(p) === "canvas" && p !== space.generated.canvas),
          updatedAt: new Date().toISOString(),
        };
    if (map.linkKind === "none") map.linkKind = "prerequisite";
    if (!map.dashboardTitle) map.dashboardTitle = "Skill tree";
    map.preferences = job.plan.preferences.length ? job.plan.preferences : map.preferences;

    // Raw documents now archived disappear from the map: the notes replace them. Sections left
    // empty (file groupings made by an older version) go too.
    if (job.plan.language) map.language = job.plan.language;
    const archived = new Set([...report.archived, ...Object.keys(report.moved)]);
    const strip = (rs: Resource[]) => rs.filter((r) => !archived.has(r.path));
    for (const s of allSections(map)) s.resources = strip(s.resources);
    map.transverse = strip(map.transverse);
    for (const s of map.sections) s.children = s.children.filter((c) => c.resources.length || c.children.length);
    map.sections = map.sections.filter((s) => s.resources.length || s.children.length || s.id === job.plan.module.id);

    const m = job.plan.module;
    // Course-wide references (syllabus, textbooks…) sit beside the tree, not in a session.
    const isRef = (old: string) => this.disposition(job, job.sources.find((x) => x.path === old)!.id) === "reference";
    for (const old of report.kept.filter(isRef)) {
      if (map.transverse.some((r) => r.path === old) || allSections(map).some((s) => s.resources.some((r) => r.path === old))) continue;
      const src = job.sources.find((s) => s.path === old)!;
      map.transverse.push({ path: old, role: keptRole(src, job.plan.sources.find((x) => x.sourceId === src.id)?.role ?? ""), label: basename(old).replace(/\.[^.]+$/, "") });
    }
    if (!job.plan.fiches.length) {
      for (const old of report.kept.filter((p) => !isRef(p))) {
        const path = report.moved[old] ?? old;
        if (map.transverse.some((r) => r.path === path) || allSections(map).some((s) => s.resources.some((r) => r.path === path))) continue;
        const src = job.sources.find((s) => s.path === old)!;
        map.transverse.push({ path, role: keptRole(src, job.plan.sources.find((x) => x.sourceId === src.id)?.role ?? ""), label: basename(path).replace(/\.[^.]+$/, "") });
      }
      map.updatedAt = new Date().toISOString();
      return map;
    }
    let section =
      map.sections.find((s) => s.id === m.id) ?? map.sections.find((s) => s.folder === m.folder) ?? (m.mode === "existing" ? map.sections.find((s) => s.title === m.title) : undefined);
    if (!section) {
      section = { id: slugify(m.id || m.title) || `module-${map.sections.length + 1}`, title: m.title, summary: m.summary, keywords: [], dependsOn: [], folder: m.folder, resources: [], children: [] };
      map.sections.push(section);
    }
    section.folder = section.folder ?? m.folder;
    // A module the plan explicitly continues may be renamed by it (it now sees all of its notes).
    if (m.mode === "existing" && m.title.trim()) section.title = m.title.trim();
    section.summary = (m.mode === "existing" && m.summary.trim()) || section.summary || m.summary;
    const sectionIds = new Set(map.sections.map((s) => s.id));
    section.dependsOn = [...new Set([...section.dependsOn, ...m.dependsOn.filter((d) => sectionIds.has(d) && d !== section!.id)])];
    if (report.archiveDoc && !section.resources.some((r) => r.path === layout.doc)) section.resources.push({ path: layout.doc, role: "archive", label: `Transcriptions — ${job.plan.session || job.lot.name}` });
    // The session's inputs stay reachable from the skill tree: documents kept on purpose, and the archived
    // slides, sheets and notes (photos are in the transcriptions document).
    for (const old of [...report.kept.filter((p) => !isRef(p)), ...report.archived]) {
      const src = job.sources.find((s) => s.path === old)!;
      if (src.kind === "image") continue;
      const path = report.moved[old] ?? old;
      if (allSections(map).some((s) => s.resources.some((r) => r.path === path)) || map.transverse.some((r) => r.path === path)) continue;
      section.resources.push({ path, role: keptRole(src, job.plan.sources.find((x) => x.sourceId === src.id)?.role ?? ""), label: basename(path).replace(/\.[^.]+$/, "") });
    }

    for (const f of job.plan.fiches) {
      const node: SectionNode = {
        id: f.id,
        title: f.title,
        summary: f.objective,
        keywords: f.keywords,
        dependsOn: f.dependsOn,
        folder: null,
        resources: [{ path: f.path, role: "fiche", label: f.title }],
        children: [],
      };
      const existing = allSections(map).find((s) => s.id === f.id || s.resources.some((r) => r.path === f.path));
      if (existing && existing !== section) {
        Object.assign(existing, { ...node, status: existing.status, children: existing.children });
      } else if (!section.children.some((c) => c.id === f.id)) {
        section.children.push(node);
      }
    }
    // The course tree reshaped around the new session: prerequisites and summaries of earlier
    // modules and notes, and the order of the modules.
    const nodes = new Map(allSections(map).map((s) => [s.id, s]));
    for (const u of job.plan.tree.updates) {
      const node = nodes.get(u.id);
      if (!node) continue;
      node.dependsOn = [...new Set(u.dependsOn)];
      if (u.summary.trim()) node.summary = u.summary.trim();
    }
    const rank = new Map(job.plan.tree.moduleOrder.map((id, i) => [id === m.id ? section.id : id, i]));
    if (rank.size) {
      const before = new Map(map.sections.map((s, i) => [s.id, i]));
      map.sections.sort((a, b) => (rank.get(a.id) ?? 1e6 + before.get(a.id)!) - (rank.get(b.id) ?? 1e6 + before.get(b.id)!));
    }
    const known = new Set(allSections(map).map((s) => s.id));
    for (const s of allSections(map)) s.dependsOn = s.dependsOn.filter((d) => known.has(d) && d !== s.id);
    map.updatedAt = new Date().toISOString();
    return map;
  }
}

/** A note an older version of the plug-in wrote: a study note (0.4+) or a note photos were merged into (0.3, "|📷]]" links). */
function writtenByPlugin(content: string): boolean {
  return /^---[\s\S]*?\ncurator:\s*fiche\b/m.test(content.slice(0, 600)) || content.includes("|📷]]");
}

/** The frontmatter written by the pipeline survives a completion that dropped it. */
function keepFrontmatter(previous: string, next: string): string {
  const fm = /^---\n[\s\S]*?\n---\n/.exec(previous)?.[0];
  const body = next.trim();
  return `${fm && !body.startsWith("---") ? `${fm}\n${body}` : body}\n`;
}

function sourceKind(path: string, size: number): Source["kind"] {
  const ext = extname(path);
  if (ext === "md") return "markdown";
  if (ext === "pdf") return "pdf";
  if (VIEW_EXT.has(ext)) return "image";
  if (ext === "ipynb") return "notebook";
  if (["csv", "tsv", "xlsx", "xls", "zip", "parquet", "h5", "hdf5", "pkl", "pickle", "sav", "dta", "sas7bdat", "mat", "rds", "rdata", "db", "sqlite", "dat", "gz"].includes(ext)) return "data";
  if (["txt", "py", "r", "tex", "json", "sql", "rmd", "qmd"].includes(ext)) return size > DATA_TEXT_LIMIT ? "data" : "text";
  return "other";
}

/** Skill-tree role of a document kept in place. */
function keptRole(s: Source, role: string): DocType {
  if (s.kind === "notebook") return "code";
  if (s.kind === "data") return "donnees";
  const text = `${role} ${basename(s.path)}`;
  if (/syllab|planning|programme du cours|organisation/i.test(text)) return "planning";
  if (/annale|exam|exercice|problem|td\b|pc\b|homework|devoir/i.test(text)) return "exercices";
  if (/corrig|solution/i.test(text)) return "corrige";
  if (/livre|book|manuel|ouvrage|lecture|r[ée]f[ée]rence|notes de cours|lecture notes|proofs|esl|islr/i.test(text)) return "lecture";
  return "cours";
}

function cacheKey(s: Source): string {
  // PDFs: v2 since long lecture slides are read in full (0.7 only skimmed them).
  const version = s.kind === "pdf" ? ":v2" : "";
  return `extracts/${hash(`${s.size}:${Math.round(s.mtime)}:${extname(s.path)}${version}`)}.json`;
}

function splitPages(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of text.matchAll(/\[page (\d+)\]\s*([\s\S]*?)(?=\n?\[page \d+\]|$)/g)) out.set(Number(m[1]), m[2].trim());
  return out;
}

function headingsOf(md: string): string {
  return md
    .split("\n")
    .filter((l) => /^#{2,3} /.test(l))
    .map((l) => l.replace(/^#+ /, ""))
    .slice(0, 12)
    .join(" · ");
}

function feedbackText(job: SynthesisJob, f: SynthesisFeedback): string {
  const lines: string[] = [];
  for (const a of f.answers) if (a.answer.trim()) lines.push(`- Question « ${a.question} » → réponse : ${a.answer.trim()}`);
  for (const c of f.ficheComments) {
    const fiche = job.plan.fiches.find((x) => x.id === c.id);
    if (c.comment.trim()) lines.push(`- Sur la fiche « ${fiche?.title ?? c.id} » : ${c.comment.trim()}`);
  }
  for (const t of f.transcriptions) lines.push(`- Transcription de ${job.sources.find((s) => s.id === t.sourceId)?.path ?? t.sourceId} corrigée à la main (la version corrigée est dans les sources ci-dessus).`);
  if (f.general.trim()) lines.push(`- Commentaire général : ${f.general.trim()}`);
  return lines.join("\n");
}

export function relativeLabel(path: string, folder: string): string {
  return relativeTo(path, folder) || path;
}
