import { App, arrayBufferToBase64, FileSystemAdapter, loadPdfJs, normalizePath, Plugin, TFile, TFolder } from "obsidian";
import { dirname, hash } from "./core/paths";
import { VaultFile } from "./core/types";
import { VaultIO } from "./io";

const MAX_IMAGE_EDGE = 1568;

interface PdfPage {
  getTextContent(): Promise<{ items: { str?: string }[] }>;
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void> };
}
interface PdfJs {
  getDocument(src: { data: Uint8Array }): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> }>;
  };
}

export class ObsidianIO implements VaultIO {
  constructor(
    private readonly app: App,
    private readonly plugin: Plugin,
  ) {}

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) throw new Error(`${path} introuvable`);
    return f;
  }

  listFiles(): VaultFile[] {
    return this.app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }

  resolveLink(link: string, from: string): string | null {
    return this.app.metadataCache.getFirstLinkpathDest(link, from)?.path ?? null;
  }

  listFolders(): string[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
      .map((f) => f.path);
  }

  exists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  read(path: string): Promise<string> {
    return this.app.vault.read(this.file(path));
  }

  async create(path: string, content: string): Promise<void> {
    await this.ensureFolder(dirname(path));
    await this.app.vault.create(normalizePath(path), content);
  }

  async write(path: string, content: string): Promise<void> {
    await this.app.vault.modify(this.file(path), content);
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureFolder(path);
  }

  private async ensureFolder(path: string) {
    if (!path || this.exists(path)) return;
    await this.ensureFolder(dirname(path));
    await this.app.vault.createFolder(normalizePath(path));
  }

  async rmdirIfEmpty(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (f instanceof TFolder && f.children.length === 0) await this.app.vault.delete(f);
  }

  async move(from: string, to: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(from));
    if (!f) throw new Error(`${from} introuvable`);
    await this.ensureFolder(dirname(to));
    // fileManager.renameFile rewrites every link to the file, unlike vault.rename.
    await this.app.fileManager.renameFile(f, normalizePath(to));
  }

  async trash(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (f) await this.app.vault.trash(f, true);
  }

  absolutePath(path: string): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getFullPath(normalizePath(path)) : null;
  }

  async pdfPageImages(path: string, from: number, to: number): Promise<{ label: string; mediaType: string; base64: string; absPath: string | null }[]> {
    try {
      const file = this.file(path);
      const pdfjs = (await loadPdfJs()) as PdfJs;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await this.app.vault.readBinary(file)) }).promise;
      const adapter = this.app.vault.adapter;
      const dir = `${this.pluginDir}/cache/pages`;
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      const key = hash(`${path}:${file.stat.size}:${file.stat.mtime}`);
      const out = [];
      for (let n = from; n <= Math.min(to, doc.numPages); n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: MAX_IMAGE_EDGE / Math.max(base.width, base.height) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
        const pagePath = `${dir}/${key}-p${n}.jpg`;
        await adapter.writeBinary(pagePath, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer);
        out.push({ label: `page ${n}`, mediaType: "image/jpeg", base64, absPath: adapter instanceof FileSystemAdapter ? adapter.getFullPath(pagePath) : null });
      }
      await doc.destroy();
      return out;
    } catch {
      return [];
    }
  }

  async pdfText(path: string, pages: number): Promise<{ text: string; pageCount: number } | null> {
    try {
      const pdfjs = (await loadPdfJs()) as PdfJs;
      const data = new Uint8Array(await this.app.vault.readBinary(this.file(path)));
      const doc = await pdfjs.getDocument({ data }).promise;
      const parts: string[] = [];
      for (let n = 1; n <= Math.min(pages, doc.numPages); n++) {
        const content = await (await doc.getPage(n)).getTextContent();
        parts.push(`[page ${n}] ${content.items.map((i) => i.str ?? "").join(" ").replace(/\s+/g, " ")}`);
      }
      const pageCount = doc.numPages;
      await doc.destroy();
      return { text: parts.join("\n"), pageCount };
    } catch {
      return null;
    }
  }

  async binaryPayload(path: string): Promise<{ mediaType: string; base64: string } | null> {
    const buf = await this.app.vault.readBinary(this.file(path));
    if (path.toLowerCase().endsWith(".pdf")) return { mediaType: "application/pdf", base64: arrayBufferToBase64(buf) };
    try {
      const bitmap = await createImageBitmap(new Blob([buf]));
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return { mediaType: "image/jpeg", base64: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] };
    } catch {
      return null; // HEIC and other formats the webview cannot decode
    }
  }

  private get pluginDir(): string {
    return this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
  }

  async imageViews(path: string): Promise<{ label: string; mediaType: string; base64: string; absPath: string | null }[]> {
    const file = this.file(path);
    const bitmap = await createImageBitmap(new Blob([await this.app.vault.readBinary(file)]));
    const { width: W, height: H } = bitmap;
    const regions: { label: string; x: number; y: number; w: number; h: number }[] = [{ label: "vue d'ensemble", x: 0, y: 0, w: W, h: H }];
    if (Math.max(W, H) > 2000) {
      // 2×2 crops with 15 % overlap, so no line of writing is cut in every view.
      const cw = Math.round(W * 0.575);
      const ch = Math.round(H * 0.575);
      for (const [i, [x, y]] of [[0, 0], [W - cw, 0], [0, H - ch], [W - cw, H - ch]].entries()) {
        regions.push({ label: ["détail haut gauche", "détail haut droite", "détail bas gauche", "détail bas droite"][i], x, y, w: cw, h: ch });
      }
    }
    const adapter = this.app.vault.adapter;
    const dir = `${this.pluginDir}/cache/views`;
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    const key = hash(`${path}:${file.stat.size}:${file.stat.mtime}`);
    const out = [];
    for (const [i, r] of regions.entries()) {
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(r.w, r.h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(r.w * scale);
      canvas.height = Math.round(r.h * scale);
      canvas.getContext("2d")!.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
      const viewPath = `${dir}/${key}-${i}.jpg`;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await adapter.writeBinary(viewPath, bytes.buffer);
      out.push({ label: r.label, mediaType: "image/jpeg", base64, absPath: adapter instanceof FileSystemAdapter ? adapter.getFullPath(viewPath) : null });
    }
    bitmap.close();
    return out;
  }

  async cacheRead(key: string): Promise<string | null> {
    const p = `${this.pluginDir}/cache/${key}`;
    return (await this.app.vault.adapter.exists(p)) ? this.app.vault.adapter.read(p) : null;
  }

  async cacheWrite(key: string, value: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = `${this.pluginDir}/cache/${dirname(key)}`.replace(/\/$/, "");
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(`${this.pluginDir}/cache/${key}`, value);
  }

  onRename(cb: (from: string, to: string) => void): void {
    this.plugin.registerEvent(this.app.vault.on("rename", (file, oldPath) => cb(oldPath, file.path)));
  }
}
