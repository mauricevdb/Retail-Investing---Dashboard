import { App, arrayBufferToBase64, FileSystemAdapter, loadPdfJs, normalizePath, Plugin, TFile, TFolder } from "obsidian";
import { dirname } from "./core/paths";
import { VaultFile } from "./core/types";
import { VaultIO } from "./io";

const MAX_IMAGE_EDGE = 1568;

interface PdfJs {
  getDocument(src: { data: Uint8Array }): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string }[] }> }>; destroy(): Promise<void> }>;
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

  onRename(cb: (from: string, to: string) => void): void {
    this.plugin.registerEvent(this.app.vault.on("rename", (file, oldPath) => cb(oldPath, file.path)));
  }
}
