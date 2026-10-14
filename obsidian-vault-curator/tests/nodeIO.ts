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
  resolveLink(link: string, from: string) {
    const files = this.listFiles().map((f) => f.path);
    const exact = files.find((f) => f === link) ?? files.find((f) => f === path.posix.join(path.posix.dirname(from), link));
    if (exact) return exact;
    const withExt = /\.[a-z0-9]+$/i.test(link) ? link : `${link}.md`;
    return files.find((f) => f === withExt || f.endsWith(`/${withExt}`)) ?? null;
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
    // Same layout as the plugin's pdf.js extraction: one "[page n]" block per page.
    const pagesText = text.stdout.split("\f").filter((t, i, all) => i < all.length - 1 || t.trim());
    return { text: pagesText.map((t, i) => `[page ${i + 1}] ${t.replace(/\s+/g, " ").trim()}`).join("\n"), pageCount };
  }
  /** Same page images as the plugin, made with pdftoppm when it is installed. */
  async pdfPageImages(p: string, from: number, to: number) {
    const dir = path.join(this.root, ".curator-cache", "pages", p.replace(/[^\w]+/g, "_"));
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync("pdftoppm", ["-f", String(from), "-l", String(to), "-jpeg", "-scale-to", "1568", this.abs(p), path.join(dir, "p")]);
    if (r.status !== 0) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jpg"))
      .map((f) => ({ f, n: Number(/(\d+)\.jpg$/.exec(f)![1]) }))
      .filter(({ n }) => n >= from && n <= to)
      .sort((a, b) => a.n - b.n)
      .map(({ f, n }) => ({ label: `page ${n}`, mediaType: "image/jpeg", base64: fs.readFileSync(path.join(dir, f)).toString("base64"), absPath: path.join(dir, f) }));
  }
  async binaryPayload(p: string) {
    const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    const mediaType = MEDIA[ext];
    if (!mediaType) return null;
    return { mediaType, base64: fs.readFileSync(this.abs(p)).toString("base64") };
  }
  /** Same views as the plugin, made with ImageMagick when it is installed. */
  async imageViews(p: string) {
    const src = this.abs(p);
    const dir = path.join(this.root, ".curator-cache", "views");
    fs.mkdirSync(dir, { recursive: true });
    const id = Buffer.from(p).toString("hex").slice(-24);
    const size = spawnSync("identify", ["-format", "%w %h", src], { encoding: "utf8" });
    const [W, H] = (size.stdout || "0 0").split(" ").map(Number);
    const regions: [string, string][] = [["vue d'ensemble", ""]];
    if (Math.max(W, H) > 2000) {
      const cw = Math.round(W * 0.575);
      const ch = Math.round(H * 0.575);
      const pos: [number, number][] = [[0, 0], [W - cw, 0], [0, H - ch], [W - cw, H - ch]];
      ["détail haut gauche", "détail haut droite", "détail bas gauche", "détail bas droite"].forEach((label, i) => regions.push([label, `${cw}x${ch}+${pos[i][0]}+${pos[i][1]}`]));
    }
    const out = [];
    for (const [i, [label, crop]] of regions.entries()) {
      const dest = path.join(dir, `${id}-${i}.jpg`);
      const args = [src, ...(crop ? ["-crop", crop, "+repage"] : []), "-resize", "1568x1568>", "-quality", "90", dest];
      if (spawnSync("convert", args).status !== 0) {
        // No ImageMagick: send the original only.
        return [{ label: "vue d'ensemble", mediaType: "image/jpeg", base64: fs.readFileSync(src).toString("base64"), absPath: src }];
      }
      out.push({ label, mediaType: "image/jpeg", base64: fs.readFileSync(dest).toString("base64"), absPath: dest });
    }
    return out;
  }
  async cacheRead(key: string) {
    const f = path.join(this.root, ".curator-cache", key);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  }
  async cacheWrite(key: string, value: string) {
    const f = path.join(this.root, ".curator-cache", key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, value);
  }
  onRename(cb: (from: string, to: string) => void) {
    this.listeners.push(cb);
  }
}
