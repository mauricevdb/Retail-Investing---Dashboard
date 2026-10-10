// VaultIO on node:fs — used by the tests and the end-to-end harness.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { VaultFile } from "../src/core/types";
import { VaultIO } from "../src/io";

const MEDIA: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };

export class NodeIO implements VaultIO {
  private listeners: ((from: string, to: string) => void)[] = [];
  constructor(readonly root: string) {}

  private abs(p: string) {
    return path.join(this.root, ...p.split("/"));
  }

  private walk(): { files: VaultFile[]; folders: string[] } {
    const files: VaultFile[] = [];
    const folders: string[] = [];
    const visit = (rel: string) => {
      for (const entry of fs.readdirSync(this.abs(rel), { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const p = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          folders.push(p);
          visit(p);
        } else {
          const st = fs.statSync(this.abs(p));
          files.push({ path: p, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    visit("");
    return { files, folders };
  }

  listFiles() {
    return this.walk().files;
  }
  listFolders() {
    return this.walk().folders;
  }
  exists(p: string) {
    return fs.existsSync(this.abs(p));
  }
  async read(p: string) {
    return fs.readFileSync(this.abs(p), "utf8");
  }
  async create(p: string, content: string) {
    if (this.exists(p)) throw new Error(`${p} existe déjà`);
    fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true });
    fs.writeFileSync(this.abs(p), content);
  }
  async write(p: string, content: string) {
    fs.writeFileSync(this.abs(p), content);
  }
  async mkdir(p: string) {
    fs.mkdirSync(this.abs(p), { recursive: true });
  }
  async rmdirIfEmpty(p: string) {
    if (this.exists(p) && fs.readdirSync(this.abs(p)).length === 0) fs.rmdirSync(this.abs(p));
  }
  async move(from: string, to: string) {
    fs.mkdirSync(path.dirname(this.abs(to)), { recursive: true });
    fs.renameSync(this.abs(from), this.abs(to));
    for (const l of this.listeners) l(from, to);
  }
  async trash(p: string) {
    const dest = path.join(this.root, ".trash", `${Date.now()}-${path.basename(p)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(this.abs(p), dest);
  }
  absolutePath(p: string) {
    return this.abs(p);
  }
  /** Text layer via poppler's pdftotext when installed (the plugin uses Obsidian's pdf.js). */
  async pdfText(p: string, pages: number) {
    const text = spawnSync("pdftotext", ["-l", String(pages), "-layout", this.abs(p), "-"], { encoding: "utf8" });
    const info = spawnSync("pdfinfo", [this.abs(p)], { encoding: "utf8" });
    if (text.status !== 0) return null;
    const pageCount = Number(/Pages:\s+(\d+)/.exec(info.stdout ?? "")?.[1] ?? 0);
    return { text: text.stdout, pageCount };
  }
  async binaryPayload(p: string) {
    const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    const mediaType = MEDIA[ext];
    if (!mediaType) return null;
    return { mediaType, base64: fs.readFileSync(this.abs(p)).toString("base64") };
  }
  onRename(cb: (from: string, to: string) => void) {
    this.listeners.push(cb);
  }
}
