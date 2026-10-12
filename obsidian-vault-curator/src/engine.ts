// Orchestrates the workflows on managed folders ("spaces"):
//   scan → digest → understand + plan (Claude) → feedback ⇄ revision → apply → dashboards.
// Talks to the vault only through VaultIO, so the whole pipeline also runs under node for tests.
import { buildCanvas, describeCanvas, parseCanvas, readStatuses } from "./core/canvas";
import { mergeIndex, renderIndexBody } from "./core/indexNote";
import { applyPatch, attachTranscripts, carryStatuses, MapPatch, normaliseRole, upgradeMap } from "./core/mapMerge";
import { basename, dirname, extname, isInside, join, matchPath, normalize, slugify } from "./core/paths";
import {
  allResourcePaths,
  allSections,
  checkPlan,
  Fillers,
  IntegrationRequest,
  lostLines,
  pathRewriter,
  PlanContext,
  reconcileMap,
  renameInMap,
  resolvePath,
  VaultState,
} from "./core/plan";
import { fileKind, fingerprint, isIgnored, scanVault, SpaceInventory, VaultScan } from "./core/scan";
import { CuratorSettings, newSpace, SpaceConfig, SpaceMode } from "./core/settings";
import { CheckedOp, Feedback, FileDigest, JournalEntry, JournalStep, Plan, PlanOp, Resource, SectionNode, SpaceMap, VaultFile } from "./core/types";
import { VaultIO } from "./io";
import {
  digestPrompt,
  digestSystem,
  DigestItem,
  feedbackBlock,
  incrementalPrompt,
  incrementalSystem,
  initialPrompt,
  initialSystem,
  mapOutline,
  mergePrompt,
  MergeSource,
  mergeSystem,
  revisionPrompt,
  routePrompt,
  routeSystem,
} from "./llm/prompts";
import {
  DIGEST_SCHEMA,
  DigestAnswer,
  INCREMENTAL_SCHEMA,
  IncrementalAnswer,
  INITIAL_SCHEMA,
  InitialAnswer,
  MERGE_SCHEMA,
  MergeAnswer,
  RawSection,
  ROUTE_SCHEMA,
  RouteAnswer,
} from "./llm/schemas";
import { Attachment, LlmBackend } from "./llm/types";

export interface LedgerEntry {
  fp: string;
  /** The file has been seen by an organisation or aggregation (it is not "new"). */
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
  mode: "initial" | "incremental";
  space: SpaceInventory;
  plan: Plan;
  /** Claude's answer as received, sent back when revising. */
  raw: InitialAnswer | IncrementalAnswer;
  /** The first request, reused for every revision. */
  request: { system: string; prompt: string };
  /** Version number of this proposal (1 = first). */
  round: number;
  /** Feedback already given on earlier versions, as text. */
  history: string[];
  state: VaultState;
  ctx: PlanContext;
  checked: CheckedOp[];
  baseMap: SpaceMap | null;
  patch: MapPatch | null;
  newFiles: VaultFile[];
  /** Digests by original path. */
  digests: Map<string, FileDigest>;
  /** Prepared merges of handwritten material into notes, by request key (kept across revisions). */
  merges: Map<string, Merge>;
}

export interface Merge {
  content: string;
  before: string | null;
  warning: string | null;
  summary: string;
}

function mergeKey(req: IntegrationRequest): string {
  return `${req.targetOrigin ?? `new:${req.target}`}|${req.sources.map((s) => `${s.origin}>${s.path}`).sort().join(",")}`;
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
const TEXT_EXT = new Set(["txt", "csv", "tsv", "json", "py", "r", "js", "ts", "sql", "tex", "bib", "ipynb", "yaml", "yml", "html"]);

export class Engine {
  /** True while the engine moves files itself: renames then only update the ledger and settings. */
  private applying = false;
  private renameListeners: ((from: string, to: string) => void)[] = [];

  constructor(
    private readonly io: VaultIO,
    private readonly llm: () => LlmBackend,
    private readonly store: Store,
    private readonly vaultName = "Vault",
  ) {
    io.onRename((from, to) => this.handleRename(from, to));
  }

  get settings(): CuratorSettings {
    return this.store.data.settings;
  }

  get data(): PluginData {
    return this.store.data;
  }

  get vault(): VaultIO {
    return this.io;
  }

  backend(): LlmBackend {
    return this.llm();
  }

  /** Runs file operations made by the plugin itself: renames then only update the ledger and settings. */
  async asPlugin<T>(fn: () => Promise<T>): Promise<T> {
    this.applying = true;
    try {
      return await fn();
    } finally {
      this.applying = false;
    }
  }

  async record(entry: JournalEntry) {
    if (entry.steps.length) this.store.data.journal = [entry, ...this.store.data.journal].slice(0, 20);
    await this.store.save();
  }

  async save() {
    await this.store.save();
  }

  /** Called after a user rename that touched a map (lets the UI refresh dashboards). */
  onMapRenamed(cb: (from: string, to: string) => void) {
    this.renameListeners.push(cb);
  }

  scan(): VaultScan {
    return scanVault(this.io.listFiles(), this.io.listFolders(), this.settings, this.vaultName);
  }

  /** Every folder of the vault, minus ignored ones and the inbox. */
  scanFolders(): string[] {
    return this.io
      .listFolders()
      .filter((f) => !isIgnored(f, this.settings) && !isInside(f, this.settings.inboxFolder) && !basename(f).startsWith("."))
      .sort((a, b) => a.localeCompare(b));
  }

  space(folder: string): SpaceInventory | undefined {
    return this.scan().spaces.find((c) => c.folder === folder);
  }

  // -------------------------------------------------------------------------
  // Managed folders

  /** Starts managing a folder. Returns an error message when it cannot. */
  async addSpace(folder: string, instructions = "", mode: SpaceMode = "files"): Promise<string | null> {
    folder = normalize(folder);
    const s = this.settings;
    if (folder !== "" && !this.io.listFolders().includes(folder)) return `Le dossier « ${folder} » n'existe pas.`;
    if (s.spaces.some((x) => x.folder === folder)) return `« ${folder || "La racine du vault"} » est déjà géré.`;
    if (isInside(folder, s.inboxFolder)) return "La boîte de réception ne peut pas être un dossier géré.";
    s.spaces.push(newSpace(s, folder, this.vaultName, instructions, mode));
    await this.store.save();
    return null;
  }

  /** Stops managing a folder. Its files, dashboards and map stay where they are. */
  async removeSpace(folder: string) {
    this.settings.spaces = this.settings.spaces.filter((x) => x.folder !== folder);
    await this.store.save();
  }

  async setInstructions(folder: string, instructions: string) {
    const space = this.settings.spaces.find((x) => x.folder === folder);
    if (space) space.instructions = instructions;
    await this.store.save();
  }

  /** Files of an organised space that no workflow has seen yet. */
  newFiles(space: SpaceInventory): VaultFile[] {
    const ledger = this.store.data.ledger;
    return space.files.filter((f) => !ledger[f.path]?.known);
  }

  async readMap(space: { generated: { map: string } } | SpaceInventory): Promise<SpaceMap | null> {
    if (!this.io.exists(space.generated.map)) return null;
    try {
      return upgradeMap(JSON.parse(await this.io.read(space.generated.map)));
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Digests

  /** Reads and summarises the files that have no up-to-date digest. Cached in the ledger. */
  async digest(spaceName: string, files: VaultFile[], progress: Progress, signal?: AbortSignal): Promise<Map<string, FileDigest>> {
    const ledger = this.store.data.ledger;
    const out = new Map<string, FileDigest>();
    const todo: VaultFile[] = [];
    for (const f of files) {
      const e = ledger[f.path];
      if (e?.digest && e.digestFp === fingerprint(f)) out.set(f.path, { ...e.digest, docType: normaliseRole(e.digest.docType) });
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
        prompt: digestPrompt(spaceName, batch.map((b) => b.item), readsFiles),
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
        const digest: FileDigest = {
          docType: normaliseRole(d.docType),
          title: d.title,
          summary: d.summary,
          topics: d.topics ?? [],
          sequence: d.sequence ?? null,
          transcript: d.transcript ?? null,
        };
        out.set(path, digest);
        const f = todo.find((t) => t.path === path)!;
        ledger[path] = { ...(ledger[path] ?? { known: false }), fp: fingerprint(f), digest, digestFp: fingerprint(f) };
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
    const ext = extname(f.path);
    const item: DigestItem = { path: f.path, size: f.size, text: null, attached: false, pageCount: null };
    const attach = (k: "image" | "pdf"): Attachment => ({
      path: f.path,
      absPath: this.io.absolutePath(f.path),
      kind: k,
      load: () => this.io.binaryPayload(f.path),
    });
    try {
      if (kind === "markdown" || (TEXT_EXT.has(ext) && f.size < 2_000_000)) {
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
      } else if (kind === "image" && VISION_EXT.has(ext) && f.size < 25_000_000) {
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

  private context(space: SpaceInventory): PlanContext {
    return {
      spaceFolder: space.folder,
      inboxFolder: this.settings.inboxFolder,
      archiveFolder: this.settings.archiveFolder,
      protectedPaths: Object.values(space.generated),
      lockedFolders: space.subspaces.map((s) => s.folder),
    };
  }

  private state(): VaultState {
    return { files: this.io.listFiles().map((f) => f.path), folders: this.io.listFolders() };
  }

  private fillers(digests: Map<string, FileDigest>, merges: Map<string, Merge>): Fillers {
    return {
      transcript: (origin, current) => {
        const t = digests.get(origin)?.transcript;
        return t ? `![[${current}]]\n\n${t.trim()}\n` : null;
      },
      integration: (req) => merges.get(mergeKey(req)) ?? null,
    };
  }

  /** Validates the ops, preparing first the merges of handwritten material the plan asks for. */
  private async finish(prepared: PreparedPlan, progress: Progress, signal?: AbortSignal): Promise<PreparedPlan> {
    const requests: IntegrationRequest[] = [];
    checkPlan(prepared.plan.ops, prepared.state, prepared.ctx, undefined, {
      integration: (req) => {
        if (!prepared.merges.has(mergeKey(req))) requests.push(req);
        return null;
      },
    });
    let done = 0;
    let next = 0;
    const errors: string[] = [];
    if (requests.length) progress(`Intégration du manuscrit dans les fiches…`, 0, requests.length);
    const workers = Array.from({ length: Math.min(this.settings.concurrency, requests.length) }, async () => {
      while (next < requests.length) {
        const req = requests[next++];
        try {
          prepared.merges.set(mergeKey(req), await this.merge(req, prepared.digests, signal));
        } catch (e) {
          if (signal?.aborted) throw e;
          errors.push(`${req.target} : ${(e as Error).message}`);
        }
        progress(`Intégration du manuscrit dans les fiches…`, ++done, requests.length);
      }
    });
    await Promise.all(workers);
    if (errors.length) progress(`${errors.length} fusion(s) impossible(s) : ${errors[0]}`);
    prepared.checked = checkPlan(prepared.plan.ops, prepared.state, prepared.ctx, undefined, this.fillers(prepared.digests, prepared.merges));
    return prepared;
  }

  /** Asks Claude to merge handwritten material into a note (existing or new). */
  private async merge(req: IntegrationRequest, digests: Map<string, FileDigest>, signal?: AbortSignal): Promise<Merge> {
    const before = req.targetOrigin ? await this.io.read(req.targetOrigin) : null;
    const backend = this.llm();
    const sources: MergeSource[] = [];
    const attachments: Attachment[] = [];
    for (const src of req.sources) {
      let text = digests.get(src.origin)?.transcript ?? null;
      if (!text && fileKind(src.origin) === "markdown") {
        // An old transcription note: its text, minus the embedded photo.
        text = (await this.io.read(src.origin)).replace(/^!\[\[[^\]]*\]\]\s*$/gm, "").trim() || null;
      }
      if (!text) {
        const kind = fileKind(src.origin) === "pdf" ? "pdf" : "image";
        attachments.push({ path: src.path, absPath: this.io.absolutePath(src.origin), kind, load: () => this.io.binaryPayload(src.origin) });
      }
      sources.push({ path: src.path, text });
    }
    const answer = await backend.complete<MergeAnswer>({
      label: `intégration dans ${basename(req.target)}`,
      system: mergeSystem(this.settings),
      prompt: mergePrompt(req.target, before, sources, backend.name === "Claude Code"),
      schema: MERGE_SCHEMA,
      model: this.settings.planModel,
      effort: "medium",
      attachments,
      maxTokens: 32000,
      signal,
    });
    const content = answer.content.endsWith("\n") ? answer.content : `${answer.content}\n`;
    const lost = before ? lostLines(before, content) : [];
    const warning = lost.length
      ? `${lost.length} ligne(s) de la fiche actuelle n'apparaissent plus (ex. « ${lost[0].slice(0, 80)} ») : vérifie l'aperçu avant d'appliquer.`
      : null;
    return { content, before, warning, summary: answer.summary ?? "" };
  }

  /** First pass on a folder: understanding, structure, dashboards arbitration and clean-up plan. */
  async planInitial(space: SpaceInventory, progress: Progress, signal?: AbortSignal): Promise<PreparedPlan> {
    const digests = await this.digest(space.name, space.files, progress, signal);
    progress(`Compréhension et plan pour « ${space.name} »…`);

    const dashboards: { path: string; description: string }[] = [];
    const candidates = new Set(space.dashboards);
    for (const f of space.files) if (digests.get(f.path)?.docType === "dashboard") candidates.add(f.path);
    for (const path of candidates) {
      const raw = await this.io.read(path).catch(() => "");
      const canvas = path.endsWith(".canvas") ? parseCanvas(raw) : null;
      dashboards.push({ path, description: canvas ? describeCanvas(canvas) : raw.slice(0, 4000) });
    }
    const subspaceMaps: { folder: string; summary: string }[] = [];
    for (const sub of space.subspaces) {
      const m = await this.readMap({ generated: { map: join(sub.folder, "_curator.json") } });
      subspaceMaps.push({ folder: sub.folder, summary: m ? `${m.kind} — ${m.summary}` : "pas encore organisé" });
    }
    const previousMap = await this.readMap(space);

    const request = {
      system: initialSystem(this.settings),
      prompt: initialPrompt(this.settings, space, digests, dashboards, subspaceMaps, previousMap),
    };
    const answer = await this.llm().complete<InitialAnswer>({
      label: `plan pour ${space.name}`,
      ...request,
      schema: INITIAL_SCHEMA,
      model: this.settings.planModel,
      effort: "high",
      maxTokens: 64000,
      signal,
    });
    return this.finish(this.prepareInitial(space, answer, request, 1, [], digests, previousMap, new Map()), progress, signal);
  }

  private prepareInitial(
    space: SpaceInventory,
    answer: InitialAnswer,
    request: { system: string; prompt: string },
    round: number,
    history: string[],
    digests: Map<string, FileDigest>,
    previousMap: SpaceMap | null,
    merges: Map<string, Merge>,
  ): PreparedPlan {
    // Every dashboard Claude chose to merge or archive must actually be archived.
    const ops: PlanOp[] = [...(answer.ops ?? [])];
    for (const d of answer.dashboards ?? []) {
      if (d.decision === "keep") continue;
      const covered = ops.some((o) => (o.kind === "archive" || o.kind === "move") && o.source === d.path);
      if (!covered) ops.push({ kind: "archive", source: d.path, target: null, content: null, reason: `Ancien dashboard (${d.decision === "merge" ? "contenu repris" : "remplacé"}) : ${d.rationale}` });
    }
    const u = answer.understanding ?? { kind: "", purpose: "", usage: "", principle: "" };
    const m = answer.map;
    const map: SpaceMap = {
      version: 2,
      name: space.name,
      folder: space.folder,
      kind: u.kind ?? "",
      summary: m.summary ?? "",
      purpose: u.purpose ?? "",
      usage: u.usage ?? "",
      conventions: m.conventions ?? "",
      preferences: m.preferences ?? previousMap?.preferences ?? [],
      dashboardTitle: m.dashboardTitle ?? "",
      linkKind: m.linkKind ?? "none",
      sections: normaliseSections(m.sections ?? []),
      transverse: fixResources(m.transverse ?? []),
      keptDashboards: (answer.dashboards ?? []).filter((d) => d.decision === "keep").map((d) => d.path),
      updatedAt: new Date().toISOString(),
    };
    const state = this.state();
    const ctx = this.context(space);
    const plan: Plan = {
      space: space.name,
      folder: space.folder,
      summary: answer.summary ?? "",
      understanding: u,
      ops,
      dashboards: answer.dashboards ?? [],
      map: carryStatuses(map, previousMap),
      questions: answer.questions ?? [],
      changes: answer.changes ?? [],
    };
    return {
      mode: "initial",
      space,
      plan,
      raw: answer,
      request,
      round,
      history,
      state,
      ctx,
      checked: [],
      baseMap: previousMap,
      patch: null,
      newFiles: space.files,
      digests,
      merges,
    };
  }

  /** New material in an organised folder: where it goes and how it joins the dashboard. */
  async planIncremental(space: SpaceInventory, files: VaultFile[], progress: Progress, signal?: AbortSignal): Promise<PreparedPlan> {
    const map = await this.readMap(space);
    if (!map) throw new Error(`« ${space.name} » n'a pas encore été organisé : lancez d'abord son organisation.`);
    const digests = await this.digest(space.name, files, progress, signal);
    progress(`Plan d'agrégation pour « ${space.name} »…`);
    const request = {
      system: incrementalSystem(this.settings),
      prompt: incrementalPrompt(this.settings, space, map, files, digests),
    };
    const answer = await this.llm().complete<IncrementalAnswer>({
      label: `agrégation dans ${space.name}`,
      ...request,
      schema: INCREMENTAL_SCHEMA,
      model: this.settings.planModel,
      effort: "high",
      maxTokens: 32000,
      signal,
    });
    return this.finish(this.prepareIncremental(space, map, files, answer, request, 1, [], digests, new Map()), progress, signal);
  }

  private prepareIncremental(
    space: SpaceInventory,
    map: SpaceMap,
    files: VaultFile[],
    answer: IncrementalAnswer,
    request: { system: string; prompt: string },
    round: number,
    history: string[],
    digests: Map<string, FileDigest>,
    merges: Map<string, Merge>,
  ): PreparedPlan {
    const state = this.state();
    const ctx = this.context(space);
    const ops = answer.ops ?? [];
    const patch: MapPatch = {
      newSections: answer.newSections ?? [],
      assignments: (answer.assignments ?? []).map((a) => ({ ...a, role: normaliseRole(a.role) })),
      keywordUpdates: answer.keywordUpdates ?? [],
    };
    const plan: Plan = {
      space: space.name,
      folder: space.folder,
      summary: answer.summary ?? "",
      understanding: { kind: map.kind, purpose: map.purpose, usage: map.usage, principle: map.conventions },
      ops,
      dashboards: [],
      map: { ...map, preferences: answer.preferences?.length ? answer.preferences : map.preferences },
      questions: answer.questions ?? [],
      changes: answer.changes ?? [],
    };
    return {
      mode: "incremental",
      space,
      plan,
      raw: answer,
      request,
      round,
      history,
      state,
      ctx,
      checked: [],
      baseMap: map,
      patch,
      newFiles: files,
      digests,
      merges,
    };
  }

  /** Sends the user's comments and answers back to Claude; returns the next version of the plan. */
  async revise(prepared: PreparedPlan, feedback: Feedback, progress: Progress, signal?: AbortSignal): Promise<PreparedPlan> {
    const current = feedbackBlock(prepared.checked, feedback);
    progress(`Révision du plan pour « ${prepared.space.name} » (version ${prepared.round + 1})…`);
    const prompt = revisionPrompt(prepared.request.prompt, prepared.raw, prepared.round, current, prepared.history);
    const history = [...prepared.history, current || "(aucun commentaire)"];
    if (prepared.mode === "initial") {
      const answer = await this.llm().complete<InitialAnswer>({
        label: `révision du plan pour ${prepared.space.name}`,
        system: prepared.request.system,
        prompt,
        schema: INITIAL_SCHEMA,
        model: this.settings.planModel,
        effort: "high",
        maxTokens: 64000,
        signal,
      });
      const next = this.prepareInitial(prepared.space, answer, prepared.request, prepared.round + 1, history, prepared.digests, prepared.baseMap, prepared.merges);
      return this.finish(next, progress, signal);
    }
    const answer = await this.llm().complete<IncrementalAnswer>({
      label: `révision de l'agrégation dans ${prepared.space.name}`,
      system: prepared.request.system,
      prompt,
      schema: INCREMENTAL_SCHEMA,
      model: this.settings.planModel,
      effort: "high",
      maxTokens: 32000,
      signal,
    });
    const next = this.prepareIncremental(prepared.space, prepared.baseMap!, prepared.newFiles, answer, prepared.request, prepared.round + 1, history, prepared.digests, prepared.merges);
    return this.finish(next, progress, signal);
  }

  /** Assigns inbox documents to managed folders. Returns folder → files. */
  async routeInbox(scan: VaultScan, progress: Progress, signal?: AbortSignal): Promise<{ routed: Map<string, VaultFile[]>; unrouted: VaultFile[] }> {
    const routed = new Map<string, VaultFile[]>();
    if (!scan.inbox.length || !scan.spaces.length) return { routed, unrouted: scan.inbox };
    const digests = await this.digest("(boîte de réception)", scan.inbox, progress, signal);
    const spaces = [];
    for (const c of scan.spaces) {
      const map = await this.readMap(c);
      const instructions = c.config.instructions ? `${c.config.instructions}\n` : "";
      spaces.push({ name: c.name, outline: instructions + (map ? mapOutline(map, false) : c.folders.slice(0, 20).join(", ")) });
    }
    progress("Attribution des documents de la boîte de réception…");
    const answer = await this.llm().complete<RouteAnswer>({
      label: "tri de la boîte de réception",
      system: routeSystem(this.settings),
      prompt: routePrompt(spaces, scan.inbox, digests),
      schema: ROUTE_SCHEMA,
      model: this.settings.digestModel,
      effort: "medium",
      maxTokens: 8000,
      signal,
    });
    const unrouted: VaultFile[] = [];
    const inboxPaths = scan.inbox.map((f) => f.path);
    const names = scan.spaces.map((c) => c.name);
    for (const f of scan.inbox) {
      const r = answer.routes?.find((x) => matchPath(x.path, inboxPaths) === f.path);
      const name = r?.space ? matchPath(r.space, names) : null;
      const space = name ? scan.spaces.find((c) => c.name === name) : undefined;
      if (!space) unrouted.push(f);
      else routed.set(space.folder, [...(routed.get(space.folder) ?? []), f]);
    }
    return { routed, unrouted };
  }

  /** Re-validates after the user toggled or edited ops in the review modal. */
  recheck(prepared: PreparedPlan, ops: PlanOp[], selected: boolean[]): CheckedOp[] {
    prepared.plan.ops = ops;
    prepared.checked = checkPlan(ops, prepared.state, prepared.ctx, selected, this.fillers(prepared.digests, prepared.merges));
    return prepared.checked;
  }

  // -------------------------------------------------------------------------
  // Applying

  async apply(prepared: PreparedPlan, selected: boolean[], progress: Progress): Promise<ApplyReport> {
    const { space, checked, state } = prepared;
    const entry: JournalEntry = {
      id: `${Date.now()}`,
      date: new Date().toISOString(),
      label: `${prepared.mode === "initial" ? "Organisation" : "Agrégation"} — ${space.name}`,
      steps: [],
      mapsBefore: { [space.folder]: prepared.baseMap },
    };
    const report: ApplyReport = { applied: 0, failed: [], dropped: [], canvas: space.generated.canvas, index: space.generated.index };
    const executed = selected.map((sel, i) => sel && !checked[i]?.error);

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
      await this.removeEmptied(todo.filter((op) => executed[op.index]), space.folder, entry.steps);

      // The map, from what really happened.
      let map: SpaceMap;
      if (prepared.mode === "initial") {
        const r = reconcileMap(prepared.plan.map, checked, state, executed);
        map = r.map;
        report.dropped = r.dropped;
      } else {
        map = prepared.plan.map;
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
      // The space folder itself may have been renamed by an op on a parent: follow the settings.
      const current = this.settings.spaces.find((s) => s.addedAt === space.config.addedAt && s.folder === space.folder) ?? space.config;
      const live = this.space(current.folder) ?? space;
      map.folder = live.folder;
      map.updatedAt = new Date().toISOString();

      await this.writeTracked(live.generated.map, JSON.stringify(map, null, 2), entry.steps);
      await this.renderDashboards(live, map, { keepLayout: true }, entry.steps);

      // Ledger: every file of the space is now known (renames already moved the digests).
      const ledger = this.store.data.ledger;
      for (const f of this.space(live.folder)?.files ?? []) {
        ledger[f.path] = { ...(ledger[f.path] ?? {}), fp: fingerprint(f), known: true, digestFp: ledger[f.path]?.digest ? fingerprint(f) : undefined };
      }
      for (const f of prepared.newFiles) {
        // Inbox files not moved stay unknown so they are proposed again next time.
        if (isInside(f.path, prepared.ctx.inboxFolder) && this.io.exists(f.path)) ledger[f.path] = { ...(ledger[f.path] ?? { fp: fingerprint(f) }), known: false };
      }
    } finally {
      this.applying = false;
      if (entry.steps.length) this.store.data.journal = [entry, ...this.store.data.journal].slice(0, 20);
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
      case "integrate": {
        if (op.before === null || op.before === undefined) {
          if (this.io.exists(op.target!)) throw new Error("la fiche existe déjà");
          await this.mkdirp(dirname(op.target!), steps);
          await this.io.create(op.target!, op.content!);
          steps.push({ type: "create", path: op.target!, content: op.content! });
        } else {
          const current = await this.io.read(op.target!);
          if (current !== op.before) throw new Error("la fiche a changé depuis la préparation du plan");
          await this.io.write(op.target!, op.content!);
          steps.push({ type: "modify", path: op.target!, before: current, after: op.content! });
        }
        return;
      }
      case "append_note": {
        const before = await this.io.read(op.target!);
        const after = `${before.trimEnd()}\n\n${op.content!.trim()}\n`;
        await this.io.write(op.target!, after);
        steps.push({ type: "modify", path: op.target!, before, after });
        return;
      }
    }
  }

  async removeEmptied(ops: CheckedOp[], spaceFolder: string, steps: JournalStep[]) {
    const candidates = new Set<string>();
    for (const op of ops) {
      if ((op.kind !== "move" && op.kind !== "archive") || !op.source) continue;
      for (let d = dirname(op.source); d && d !== spaceFolder && isInside(d, spaceFolder); d = dirname(d)) candidates.add(d);
    }
    const managed = new Set(this.settings.spaces.map((s) => s.folder));
    // Deepest first, so a parent emptied by its child's removal goes too.
    for (const d of [...candidates].sort((a, b) => b.length - a.length)) {
      if (!this.io.exists(d) || managed.has(d)) continue;
      const busy = this.io.listFiles().some((f) => isInside(f.path, d)) || this.io.listFolders().some((f) => f !== d && isInside(f, d));
      if (busy) continue;
      await this.io.rmdirIfEmpty(d);
      if (!this.io.exists(d)) steps.push({ type: "rmdir", path: d });
    }
  }

  async mkdirp(folder: string, steps: JournalStep[]) {
    const missing: string[] = [];
    for (let d = folder; d && !this.io.exists(d); d = dirname(d)) missing.unshift(d);
    for (const d of missing) {
      await this.io.mkdir(d);
      steps.push({ type: "mkdir", path: d });
    }
  }

  async writeTracked(path: string, content: string, steps: JournalStep[] | null) {
    if (this.io.exists(path)) {
      const before = await this.io.read(path);
      if (before === content) return;
      await this.io.write(path, content);
      steps?.push({ type: "modify", path, before, after: content });
    } else {
      await this.mkdirp(dirname(path), steps ?? []);
      await this.io.create(path, content);
      steps?.push({ type: "create", path, content });
    }
  }

  /** Writes the canvas dashboard and the index note from a map. */
  async renderDashboards(space: SpaceInventory, map: SpaceMap, opts: { keepLayout: boolean }, steps: JournalStep[] | null = null) {
    const previous = this.io.exists(space.generated.canvas) ? parseCanvas(await this.io.read(space.generated.canvas)) : null;
    if (previous) {
      const statuses = readStatuses(previous);
      for (const m of allSections(map)) if (statuses.has(m.id)) m.status = statuses.get(m.id);
    }
    const listed = allResourcePaths(map);
    const fresh = this.space(space.folder) ?? space;
    const unfiled = fresh.files
      .map((f) => f.path)
      .filter((p) => !listed.has(p) && !map.keptDashboards.includes(p) && fileKind(p) !== "canvas")
      .sort();
    const subspaces = fresh.subspaces.filter((s) => this.io.exists(s.canvas)).map((s) => ({ name: basename(s.folder), canvas: s.canvas }));
    const canvas = buildCanvas(map, { index: space.generated.index, unfiled, subspaces }, previous ?? undefined, opts);
    await this.writeTracked(space.generated.canvas, JSON.stringify(canvas, null, "\t"), steps);
    const existingIndex = this.io.exists(space.generated.index) ? await this.io.read(space.generated.index) : null;
    await this.writeTracked(space.generated.index, mergeIndex(existingIndex, renderIndexBody(map, space.generated.canvas, unfiled, subspaces), space.name), steps);
  }

  /** Regenerates the dashboards of a space from its stored map (no Claude call). */
  async refreshDashboards(space: SpaceInventory, keepLayout = true): Promise<boolean> {
    const map = await this.readMap(space);
    if (!map) return false;
    await this.renderDashboards(space, map, { keepLayout });
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
    const re = (p: string) => (isInside(p, from) ? to + p.slice(from.length) : p);
    const ledger = this.store.data.ledger;
    for (const key of Object.keys(ledger)) {
      if (isInside(key, from)) {
        ledger[re(key)] = ledger[key];
        delete ledger[key];
      }
    }
    // Managed folders and their dashboards follow renames, whoever makes them.
    for (const s of this.settings.spaces as SpaceConfig[]) {
      if (s.folder !== "") s.folder = re(s.folder);
      s.canvas = re(s.canvas);
      s.index = re(s.index);
    }
    void this.store.save();
    if (this.applying) return;
    for (const cb of this.renameListeners) cb(from, to);
  }

  /** Rewrites the maps after a user rename; returns the spaces whose map changed. */
  async followRename(from: string, to: string): Promise<SpaceInventory[]> {
    const changed: SpaceInventory[] = [];
    for (const space of this.scan().spaces) {
      const map = await this.readMap(space);
      if (!map) continue;
      const next = { ...renameInMap(map, from, to), folder: space.folder };
      if (JSON.stringify(next) === JSON.stringify(map)) continue;
      await this.io.write(space.generated.map, JSON.stringify(next, null, 2));
      changed.push(space);
    }
    return changed;
  }
}

function describeStep(step: JournalStep): string {
  return step.type === "move" ? `${step.from} → ${step.to}` : step.path;
}

function fixResources(rs: Resource[]): Resource[] {
  return (rs ?? []).map((r) => ({ ...r, role: normaliseRole(r.role) }));
}

/** Makes Claude's sections safe: unique ids, arrays present, one level of children. */
export function normaliseSections(raw: RawSection[]): SectionNode[] {
  const seen = new Set<string>();
  const uid = (id: string, title: string) => {
    let base = id?.trim() || slugify(title) || "section";
    while (seen.has(base)) base = `${base}-b`;
    seen.add(base);
    return base;
  };
  const conv = (m: RawSection, depth: number): SectionNode => ({
    id: uid(m.id, m.title),
    title: m.title?.trim() || basename(m.folder ?? "") || "Section",
    summary: m.summary ?? "",
    keywords: m.keywords ?? [],
    dependsOn: m.dependsOn ?? [],
    folder: m.folder ?? null,
    resources: fixResources(m.resources),
    children: depth === 0 ? (m.children ?? []).map((c) => conv(c, 1)) : [],
  });
  return raw.map((m) => conv(m, 0));
}
