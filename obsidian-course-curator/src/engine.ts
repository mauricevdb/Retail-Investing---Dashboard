// Orchestrates the workflows: scan → digest → plan (Claude) → review (UI) → apply → dashboards.
// Talks to the vault only through VaultIO, so the whole pipeline also runs under node for tests.
import { buildCanvas, describeCanvas, parseCanvas, readStatuses } from "./core/canvas";
import { mergeIndex, renderIndexBody } from "./core/indexNote";
import { applyPatch, attachTranscripts, carryStatuses, MapPatch } from "./core/mapMerge";
import { basename, dirname, extname, isInside, join, matchPath, slugify } from "./core/paths";
import {
  allModules,
  allResourcePaths,
  checkPlan,
  pathRewriter,
  PlanContext,
  reconcileMap,
  renameInMap,
  resolvePath,
  VaultState,
} from "./core/plan";
import { CourseInventory, fileKind, fingerprint, scanVault, VaultScan } from "./core/scan";
import { CuratorSettings } from "./core/settings";
import { CheckedOp, CourseMap, FileDigest, JournalEntry, JournalStep, ModuleNode, Plan, PlanOp, VaultFile } from "./core/types";
import { VaultIO } from "./io";
import {
  digestPrompt,
  digestSystem,
  DigestItem,
  incrementalPrompt,
  incrementalSystem,
  mapOutline,
  onboardPrompt,
  onboardSystem,
  routePrompt,
  routeSystem,
} from "./llm/prompts";
import { DIGEST_SCHEMA, DigestAnswer, INCREMENTAL_SCHEMA, IncrementalAnswer, ONBOARD_SCHEMA, OnboardAnswer, RawModule, ROUTE_SCHEMA, RouteAnswer } from "./llm/schemas";
import { Attachment, LlmBackend } from "./llm/types";

export interface LedgerEntry {
  fp: string;
  /** The file has been seen by an onboarding or aggregation (it is not "new"). */
  known: boolean;
  digest?: FileDigest;
  digestFp?: string;
}

export interface PluginData {
  settings: CuratorSettings;
  ledger: Record<string, LedgerEntry>;
  journal: JournalEntry[];
}

export interface Store {
  data: PluginData;
  save(): Promise<void>;
}

export type Progress = (message: string, done?: number, total?: number) => void;

export interface PreparedPlan {
  mode: "onboard" | "incremental";
  course: CourseInventory;
  plan: Plan;
  state: VaultState;
  ctx: PlanContext;
  checked: CheckedOp[];
  baseMap: CourseMap | null;
  patch: MapPatch | null;
  newFiles: VaultFile[];
  /** Digests by original path, to carry them to the files' new paths. */
  digests: Map<string, FileDigest>;
}

export interface ApplyReport {
  applied: number;
  failed: { op: CheckedOp; error: string }[];
  dropped: string[];
  canvas: string;
  index: string;
}

const MAX_TEXT = 5000;
const VISION_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export class Engine {
  /** True while the engine moves files itself: renames then only update the ledger. */
  private applying = false;
  private renameListeners: ((from: string, to: string) => void)[] = [];

  constructor(
    private readonly io: VaultIO,
    private readonly llm: () => LlmBackend,
    private readonly store: Store,
  ) {
    io.onRename((from, to) => this.handleRename(from, to));
  }

  get settings(): CuratorSettings {
    return this.store.data.settings;
  }

  /** Called after a user rename that touched a course map (lets the UI refresh dashboards). */
  onMapRenamed(cb: (from: string, to: string) => void) {
    this.renameListeners.push(cb);
  }

  scan(): VaultScan {
    return scanVault(this.io.listFiles(), this.io.listFolders(), this.settings);
  }

  course(folder: string): CourseInventory | undefined {
    return this.scan().courses.find((c) => c.folder === folder);
  }

  /** Files of an organised course that no workflow has seen yet. */
  newFiles(course: CourseInventory): VaultFile[] {
    const ledger = this.store.data.ledger;
    return course.files.filter((f) => !ledger[f.path]?.known && !isInside(f.path, join(course.folder, this.settings.archiveFolder)));
  }

  async readMap(course: CourseInventory): Promise<CourseMap | null> {
    if (!this.io.exists(course.generated.map)) return null;
    try {
      return JSON.parse(await this.io.read(course.generated.map)) as CourseMap;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Digests

  /** Reads and summarises the files that have no up-to-date digest. Cached in the ledger. */
  async digest(courseName: string, files: VaultFile[], progress: Progress, signal?: AbortSignal): Promise<Map<string, FileDigest>> {
    const ledger = this.store.data.ledger;
    const out = new Map<string, FileDigest>();
    const todo: VaultFile[] = [];
    for (const f of files) {
      const e = ledger[f.path];
      if (e?.digest && e.digestFp === fingerprint(f)) out.set(f.path, e.digest);
      else todo.push(f);
    }
    if (!todo.length) return out;

    const s = this.settings;
    const backend = this.llm();
    const readsFiles = backend.name === "Claude Code";
    progress(`Lecture de ${todo.length} fichier(s)…`, 0, todo.length);

    // Prepare inputs: extract text locally when possible, attach the rest.
    const items: { item: DigestItem; attachment: Attachment | null }[] = [];
    for (const f of todo) {
      signal?.throwIfAborted();
      items.push(await this.digestInput(f));
    }

    const batches: (typeof items)[] = [];
    let current: typeof items = [];
    let chars = 0;
    for (const it of items) {
      const limit = it.attachment ? 3 : s.batchSize;
      const len = it.item.text?.length ?? 200;
      if (current.length && (current.length >= limit || chars + len > 40_000 || !!current[0].attachment !== !!it.attachment)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(it);
      chars += len;
    }
    if (current.length) batches.push(current);

    let done = 0;
    const run = async (batch: typeof items) => {
      signal?.throwIfAborted();
      const answer = await backend.complete<DigestAnswer>({
        label: `lecture de ${batch.length} fichier(s)`,
        system: digestSystem(s),
        prompt: digestPrompt(courseName, batch.map((b) => b.item), readsFiles),
        schema: DIGEST_SCHEMA,
        model: s.digestModel,
        effort: "low",
        attachments: batch.flatMap((b) => (b.attachment ? [b.attachment] : [])),
        maxTokens: 16000,
        signal,
      });
      for (const d of answer.files ?? []) {
        const path = matchPath(d.path, batch.map((b) => b.item.path));
        if (!path) continue;
        d.path = path;
        const digest: FileDigest = {
          docType: d.docType,
          title: d.title,
          summary: d.summary,
          topics: d.topics ?? [],
          sequence: d.sequence ?? null,
          transcript: d.transcript ?? null,
        };
        out.set(d.path, digest);
        const f = todo.find((t) => t.path === d.path)!;
        ledger[d.path] = { ...(ledger[d.path] ?? { known: false }), fp: fingerprint(f), digest, digestFp: fingerprint(f) };
      }
      done += batch.length;
      progress(`Lecture des fichiers…`, done, todo.length);
      await this.store.save();
    };

    const errors: string[] = [];
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(s.concurrency, batches.length)) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        try {
          await run(batch);
        } catch (e) {
          if (signal?.aborted) throw e;
          errors.push((e as Error).message);
          done += batch.length;
        }
      }
    });
    await Promise.all(workers);
    if (errors.length && out.size === 0) throw new Error(errors[0]);
    if (errors.length) progress(`${errors.length} lot(s) illisible(s) : classement sur le nom seul. (${errors[0]})`);
    return out;
  }

  private async digestInput(f: VaultFile): Promise<{ item: DigestItem; attachment: Attachment | null }> {
    const kind = fileKind(f.path);
    const item: DigestItem = { path: f.path, size: f.size, text: null, attached: false, pageCount: null };
    const attach = (k: "image" | "pdf"): Attachment => ({
      path: f.path,
      absPath: this.io.absolutePath(f.path),
      kind: k,
      load: () => this.io.binaryPayload(f.path),
    });
    try {
      if (kind === "markdown") {
        item.text = (await this.io.read(f.path)).slice(0, MAX_TEXT);
      } else if (kind === "canvas") {
        const c = parseCanvas(await this.io.read(f.path));
        item.text = c ? describeCanvas(c, MAX_TEXT) : null;
      } else if (kind === "pdf") {
        const pdf = await this.io.pdfText(f.path, this.settings.pdfPages);
        item.pageCount = pdf?.pageCount ?? null;
        if (pdf && pdf.text.replace(/\s/g, "").length > 300) item.text = pdf.text.slice(0, MAX_TEXT);
        else if (f.size < 15_000_000) {
          item.attached = true;
          return { item, attachment: attach("pdf") };
        }
      } else if (kind === "image" && VISION_EXT.has(extname(f.path)) && f.size < 25_000_000) {
        item.attached = true;
        return { item, attachment: attach("image") };
      }
    } catch {
      item.text = null;
    }
    return { item, attachment: null };
  }

  // -------------------------------------------------------------------------
  // Planning

  private context(course: CourseInventory): PlanContext {
    return {
      courseFolder: course.folder,
      inboxFolder: join(this.settings.coursesRoot, this.settings.inboxFolder),
      archiveFolder: this.settings.archiveFolder,
      protectedPaths: Object.values(course.generated),
    };
  }

  private state(): VaultState {
    return { files: this.io.listFiles().map((f) => f.path), folders: this.io.listFolders() };
  }

  private transcriptFiller(digests: Map<string, FileDigest>) {
    return (origin: string, current: string) => {
      const t = digests.get(origin)?.transcript;
      return t ? `![[${current}]]\n\n${t.trim()}\n` : null;
    };
  }

  /** First pass on a course: full structure, dashboards arbitration and clean-up plan. */
  async planOnboarding(course: CourseInventory, progress: Progress, signal?: AbortSignal): Promise<PreparedPlan> {
    const digests = await this.digest(course.name, course.files, progress, signal);
    progress(`Conception de la structure de « ${course.name} »…`);

    const dashboards: { path: string; description: string }[] = [];
    const candidates = new Set(course.dashboards);
    for (const f of course.files) {
      if (digests.get(f.path)?.docType === "dashboard") candidates.add(f.path);
    }
    for (const path of candidates) {
      const raw = await this.io.read(path).catch(() => "");
      const canvas = path.endsWith(".canvas") ? parseCanvas(raw) : null;
      dashboards.push({ path, description: canvas ? describeCanvas(canvas) : raw.slice(0, 4000) });
    }
    const previousMap = await this.readMap(course);

    const answer = await this.llm().complete<OnboardAnswer>({
      label: `structure de ${course.name}`,
      system: onboardSystem(this.settings),
      prompt: onboardPrompt(this.settings, course, digests, dashboards, previousMap),
      schema: ONBOARD_SCHEMA,
      model: this.settings.planModel,
      effort: "high",
      maxTokens: 64000,
      signal,
    });

    // Every dashboard Claude chose to merge or archive must actually be archived.
    const ops: PlanOp[] = [...(answer.ops ?? [])];
    for (const d of answer.dashboards ?? []) {
      if (d.decision === "keep") continue;
      const covered = ops.some((o) => (o.kind === "archive" || o.kind === "move") && o.source === d.path);
      if (!covered) ops.push({ kind: "archive", source: d.path, target: null, content: null, reason: `Ancien dashboard (${d.decision === "merge" ? "contenu repris" : "remplacé"}) : ${d.rationale}` });
    }

    const courseMap: CourseMap = {
      version: 1,
      course: course.name,
      folder: course.folder,
      summary: answer.courseMap.summary,
      modules: normaliseModules(answer.courseMap.modules ?? []),
      transverse: answer.courseMap.transverse ?? [],
      keptDashboards: (answer.dashboards ?? []).filter((d) => d.decision === "keep").map((d) => d.path),
      updatedAt: new Date().toISOString(),
    };

    const state = this.state();
    const ctx = this.context(course);
    const plan: Plan = {
      course: course.name,
      folder: course.folder,
      summary: answer.summary,
      ops,
      dashboards: answer.dashboards ?? [],
      courseMap: carryStatuses(courseMap, previousMap),
      questions: answer.questions ?? [],
    };
    return {
      mode: "onboard",
      course,
      plan,
      state,
      ctx,
      checked: checkPlan(ops, state, ctx, undefined, this.transcriptFiller(digests)),
      baseMap: previousMap,
      patch: null,
      newFiles: course.files,
      digests,
    };
  }

  /** New documents in an organised course: where they go and how they join the skill tree. */
  async planIncremental(course: CourseInventory, files: VaultFile[], progress: Progress, signal?: AbortSignal): Promise<PreparedPlan> {
    const map = await this.readMap(course);
    if (!map) throw new Error(`« ${course.name} » n'a pas encore été organisé : lancez d'abord l'organisation complète du cours.`);
    const digests = await this.digest(course.name, files, progress, signal);
    progress(`Plan d'agrégation pour « ${course.name} »…`);

    const answer = await this.llm().complete<IncrementalAnswer>({
      label: `agrégation dans ${course.name}`,
      system: incrementalSystem(this.settings),
      prompt: incrementalPrompt(this.settings, course, map, files, digests),
      schema: INCREMENTAL_SCHEMA,
      model: this.settings.planModel,
      effort: "high",
      maxTokens: 32000,
      signal,
    });

    const state = this.state();
    const ctx = this.context(course);
    const ops = answer.ops ?? [];
    const patch: MapPatch = {
      newModules: answer.newModules ?? [],
      assignments: answer.assignments ?? [],
      conceptUpdates: answer.conceptUpdates ?? [],
    };
    const plan: Plan = {
      course: course.name,
      folder: course.folder,
      summary: answer.summary,
      ops,
      dashboards: [],
      courseMap: map,
      questions: answer.questions ?? [],
    };
    return {
      mode: "incremental",
      course,
      plan,
      state,
      ctx,
      checked: checkPlan(ops, state, ctx, undefined, this.transcriptFiller(digests)),
      baseMap: map,
      patch,
      newFiles: files,
      digests,
    };
  }

  /** Assigns inbox documents to courses. Returns course folder → files. */
  async routeInbox(scan: VaultScan, progress: Progress, signal?: AbortSignal): Promise<{ routed: Map<string, VaultFile[]>; unrouted: VaultFile[] }> {
    const routed = new Map<string, VaultFile[]>();
    if (!scan.inbox.length) return { routed, unrouted: [] };
    const digests = await this.digest("(boîte de réception)", scan.inbox, progress, signal);
    const courses = [];
    for (const c of scan.courses) {
      const map = await this.readMap(c);
      courses.push({ name: c.name, outline: map ? mapOutline(map, false) : c.structure.topFolders.map((t) => t.name).join(", ") });
    }
    progress("Attribution des documents de la boîte de réception…");
    const answer = await this.llm().complete<RouteAnswer>({
      label: "tri de la boîte de réception",
      system: routeSystem(),
      prompt: routePrompt(courses, scan.inbox, digests),
      schema: ROUTE_SCHEMA,
      model: this.settings.digestModel,
      effort: "medium",
      maxTokens: 8000,
      signal,
    });
    const unrouted: VaultFile[] = [];
    const inboxPaths = scan.inbox.map((f) => f.path);
    const courseNames = scan.courses.map((c) => c.name);
    for (const f of scan.inbox) {
      const r = answer.routes?.find((x) => matchPath(x.path, inboxPaths) === f.path);
      const name = r?.course ? matchPath(r.course, courseNames) : null;
      const course = name ? scan.courses.find((c) => c.name === name) : undefined;
      if (!course) unrouted.push(f);
      else routed.set(course.folder, [...(routed.get(course.folder) ?? []), f]);
    }
    return { routed, unrouted };
  }

  /** Re-validates after the user toggled or edited ops in the review modal. */
  recheck(prepared: PreparedPlan, ops: PlanOp[], selected: boolean[]): CheckedOp[] {
    prepared.checked = checkPlan(ops, prepared.state, prepared.ctx, selected, this.transcriptFiller(prepared.digests));
    return prepared.checked;
  }

  // -------------------------------------------------------------------------
  // Applying

  async apply(prepared: PreparedPlan, selected: boolean[], progress: Progress): Promise<ApplyReport> {
    const { course, checked, state } = prepared;
    const entry: JournalEntry = {
      id: `${Date.now()}`,
      date: new Date().toISOString(),
      label: `${prepared.mode === "onboard" ? "Organisation" : "Agrégation"} — ${course.name}`,
      steps: [],
      mapsBefore: { [course.folder]: prepared.baseMap },
    };
    const report: ApplyReport = { applied: 0, failed: [], dropped: [], canvas: course.generated.canvas, index: course.generated.index };
    const executed = selected.map((sel, i) => sel && !checked[i].error);

    this.applying = true;
    try {
      const todo = checked.filter((op) => executed[op.index]);
      for (const [i, op] of todo.entries()) {
        progress("Application du plan…", i, todo.length);
        try {
          await this.execute(op, entry.steps);
          report.applied++;
        } catch (e) {
          executed[op.index] = false;
          report.failed.push({ op, error: (e as Error).message });
        }
      }

      // Folders emptied by the moves are removed (journaled, so undo recreates them).
      await this.removeEmptied(todo.filter((op) => executed[op.index]), course.folder, entry.steps);

      // Course map, from what really happened.
      let map: CourseMap;
      if (prepared.mode === "onboard") {
        const r = reconcileMap(prepared.plan.courseMap, checked, state, executed);
        map = r.map;
        report.dropped = r.dropped;
      } else {
        map = prepared.baseMap!;
        for (const op of checked) {
          if (executed[op.index] && (op.kind === "move" || op.kind === "archive") && op.source && op.target) map = renameInMap(map, op.source, op.target);
        }
        const rewrite = pathRewriter(checked, state, executed);
        const patch = structuredClone(prepared.patch!);
        patch.assignments = patch.assignments.flatMap((a) => {
          const resolved = resolvePath(a.path, prepared.ctx);
          const path = resolved ? rewrite(resolved) : null;
          if (!path) report.dropped.push(a.path);
          return path ? [{ ...a, path }] : [];
        });
        map = applyPatch(map, patch);
      }
      map = attachTranscripts(
        map,
        checked.filter((op) => executed[op.index] && op.kind === "transcribe").map((op) => ({ image: op.source!, note: op.target! })),
      );
      map.updatedAt = new Date().toISOString();

      await this.writeTracked(course.generated.map, JSON.stringify(map, null, 2), entry.steps);
      await this.renderDashboards(course, map, { keepLayout: true }, entry.steps);

      // Ledger: every file of the course is now known (renames already moved the digests).
      const ledger = this.store.data.ledger;
      const fresh = this.course(course.folder);
      for (const f of fresh?.files ?? []) {
        ledger[f.path] = { ...(ledger[f.path] ?? {}), fp: fingerprint(f), known: true, digestFp: ledger[f.path]?.digest ? fingerprint(f) : undefined };
      }
      for (const f of prepared.newFiles) {
        // Inbox files not moved stay unknown so they are proposed again next time.
        if (isInside(f.path, prepared.ctx.inboxFolder) && this.io.exists(f.path)) ledger[f.path] = { ...(ledger[f.path] ?? { fp: fingerprint(f) }), known: false };
      }
    } finally {
      this.applying = false;
      if (entry.steps.length) {
        this.store.data.journal = [entry, ...this.store.data.journal].slice(0, 20);
      }
      await this.store.save();
    }
    return report;
  }

  private async execute(op: CheckedOp, steps: JournalStep[]) {
    switch (op.kind) {
      case "mkdir":
        await this.mkdirp(op.target!, steps);
        return;
      case "move":
      case "archive":
        if (this.io.exists(op.target!)) throw new Error("la destination existe déjà");
        await this.mkdirp(dirname(op.target!), steps);
        await this.io.move(op.source!, op.target!);
        steps.push({ type: "move", from: op.source!, to: op.target! });
        return;
      case "create_note":
      case "transcribe":
        await this.mkdirp(dirname(op.target!), steps);
        await this.io.create(op.target!, op.content!);
        steps.push({ type: "create", path: op.target!, content: op.content! });
        return;
      case "append_note": {
        const before = await this.io.read(op.target!);
        const after = `${before.trimEnd()}\n\n${op.content!.trim()}\n`;
        await this.io.write(op.target!, after);
        steps.push({ type: "modify", path: op.target!, before, after });
        return;
      }
    }
  }

  private async removeEmptied(ops: CheckedOp[], courseFolder: string, steps: JournalStep[]) {
    const candidates = new Set<string>();
    for (const op of ops) {
      if ((op.kind !== "move" && op.kind !== "archive") || !op.source) continue;
      for (let d = dirname(op.source); d && d !== courseFolder && isInside(d, courseFolder); d = dirname(d)) candidates.add(d);
    }
    // Deepest first, so a parent emptied by its child's removal goes too.
    for (const d of [...candidates].sort((a, b) => b.length - a.length)) {
      if (!this.io.exists(d)) continue;
      const busy = this.io.listFiles().some((f) => isInside(f.path, d)) || this.io.listFolders().some((f) => f !== d && isInside(f, d));
      if (busy) continue;
      await this.io.rmdirIfEmpty(d);
      if (!this.io.exists(d)) steps.push({ type: "rmdir", path: d });
    }
  }

  private async mkdirp(folder: string, steps: JournalStep[]) {
    const missing: string[] = [];
    for (let d = folder; d && !this.io.exists(d); d = dirname(d)) missing.unshift(d);
    for (const d of missing) {
      await this.io.mkdir(d);
      steps.push({ type: "mkdir", path: d });
    }
  }

  private async writeTracked(path: string, content: string, steps: JournalStep[] | null) {
    if (this.io.exists(path)) {
      const before = await this.io.read(path);
      if (before === content) return;
      await this.io.write(path, content);
      steps?.push({ type: "modify", path, before, after: content });
    } else {
      await this.io.create(path, content);
      steps?.push({ type: "create", path, content });
    }
  }

  /** Writes the skill-tree canvas and the index note from a course map. */
  async renderDashboards(course: CourseInventory, map: CourseMap, opts: { keepLayout: boolean }, steps: JournalStep[] | null = null) {
    const previous = this.io.exists(course.generated.canvas) ? parseCanvas(await this.io.read(course.generated.canvas)) : null;
    if (previous) {
      const statuses = readStatuses(previous);
      for (const m of allModules(map)) if (statuses.has(m.id)) m.status = statuses.get(m.id);
    }
    const listed = allResourcePaths(map);
    const fresh = this.course(course.folder) ?? course;
    const unfiled = fresh.files
      .map((f) => f.path)
      .filter((p) => !listed.has(p) && !map.keptDashboards.includes(p) && fileKind(p) !== "canvas")
      .sort();
    const canvas = buildCanvas(map, { index: course.generated.index, unfiled }, previous ?? undefined, opts);
    await this.writeTracked(course.generated.canvas, JSON.stringify(canvas, null, "\t"), steps);
    const existingIndex = this.io.exists(course.generated.index) ? await this.io.read(course.generated.index) : null;
    await this.writeTracked(course.generated.index, mergeIndex(existingIndex, renderIndexBody(map, course.generated.canvas, unfiled), course.name), steps);
  }

  /** Regenerates the dashboards of a course from its stored map (no Claude call). */
  async refreshDashboards(course: CourseInventory, keepLayout = true): Promise<boolean> {
    const map = await this.readMap(course);
    if (!map) return false;
    await this.renderDashboards(course, map, { keepLayout });
    return true;
  }

  // -------------------------------------------------------------------------
  // Undo

  async undoLast(): Promise<{ label: string; warnings: string[] } | null> {
    const entry = this.store.data.journal[0];
    if (!entry) return null;
    const warnings: string[] = [];
    this.applying = true;
    try {
      for (const step of [...entry.steps].reverse()) {
        try {
          if (step.type === "move") {
            if (!this.io.exists(step.to)) warnings.push(`${step.to} n'existe plus`);
            else if (this.io.exists(step.from)) warnings.push(`${step.from} est déjà occupé`);
            else {
              await this.mkdirp(dirname(step.from), []);
              await this.io.move(step.to, step.from);
            }
          } else if (step.type === "create") {
            if (!this.io.exists(step.path)) continue;
            if ((await this.io.read(step.path)) === step.content) await this.io.trash(step.path);
            else warnings.push(`${step.path} a été modifié depuis : conservé`);
          } else if (step.type === "modify") {
            if (!this.io.exists(step.path)) continue;
            if ((await this.io.read(step.path)) === step.after) await this.io.write(step.path, step.before);
            else warnings.push(`${step.path} a été modifié depuis : non restauré`);
          } else if (step.type === "mkdir") {
            await this.io.rmdirIfEmpty(step.path);
          } else if (step.type === "rmdir") {
            await this.mkdirp(step.path, []);
          }
        } catch (e) {
          warnings.push(`${describeStep(step)} : ${(e as Error).message}`);
        }
      }
    } finally {
      this.applying = false;
    }
    this.store.data.journal = this.store.data.journal.slice(1);
    await this.store.save();
    return { label: entry.label, warnings };
  }

  // -------------------------------------------------------------------------
  // Renames

  private handleRename(from: string, to: string) {
    const ledger = this.store.data.ledger;
    for (const key of Object.keys(ledger)) {
      if (isInside(key, from)) {
        ledger[to + key.slice(from.length)] = ledger[key];
        delete ledger[key];
      }
    }
    void this.store.save();
    if (this.applying) return;
    for (const cb of this.renameListeners) cb(from, to);
  }

  /** Rewrites the course maps after a user rename; returns the courses whose map changed. */
  async followRename(from: string, to: string): Promise<CourseInventory[]> {
    const changed: CourseInventory[] = [];
    for (const course of this.scan().courses) {
      const map = await this.readMap(course);
      if (!map) continue;
      const next = renameInMap(map, from, to);
      if (JSON.stringify(next) === JSON.stringify(map)) continue;
      await this.io.write(course.generated.map, JSON.stringify(next, null, 2));
      changed.push(course);
    }
    return changed;
  }
}

function describeStep(step: JournalStep): string {
  return step.type === "move" ? `${step.from} → ${step.to}` : step.path;
}

/** Makes Claude's modules safe: unique ids, arrays present, one level of children. */
export function normaliseModules(raw: RawModule[]): ModuleNode[] {
  const seen = new Set<string>();
  const uid = (id: string, title: string) => {
    let base = id?.trim() || slugify(title) || "module";
    while (seen.has(base)) base = `${base}-b`;
    seen.add(base);
    return base;
  };
  const conv = (m: RawModule, depth: number): ModuleNode => ({
    id: uid(m.id, m.title),
    title: m.title?.trim() || basename(m.folder ?? "") || "Module",
    summary: m.summary ?? "",
    concepts: m.concepts ?? [],
    prerequisites: m.prerequisites ?? [],
    folder: m.folder ?? null,
    resources: m.resources ?? [],
    children: depth === 0 ? (m.children ?? []).map((c) => conv(c, 1)) : [],
  });
  return raw.map((m) => conv(m, 0));
}
