// Reading raw documents as the user actually stores them: photos pasted into notes, Jupyter notebooks, data files.

/** One embed of a note: `![[photo.jpg|300]]`, `![[doc.pdf#page=2]]`, `![](Attachments/photo%201.png)`. */
export interface Embed {
  raw: string;
  link: string;
}

const WIKI_EMBED = /!\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MD_EMBED = /!\[[^\]]*\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g;

export function embedsOf(markdown: string): Embed[] {
  const out: Embed[] = [];
  for (const m of markdown.matchAll(WIKI_EMBED)) out.push({ raw: m[0], link: m[1].trim() });
  for (const m of markdown.matchAll(MD_EMBED)) {
    if (/^[a-z]+:/i.test(m[1])) continue; // web images
    let link = m[1];
    try {
      link = decodeURIComponent(link);
    } catch {
      /* keep as is */
    }
    out.push({ raw: m[0], link });
  }
  return out;
}

/** Marks, in a note, where each embedded photo sits and which source carries its transcription. */
export function annotateEmbeds(markdown: string, ids: Map<string, string>): string {
  let text = markdown;
  for (const [raw, id] of ids) text = text.split(raw).join(`${raw} ⟨photo transcrite : voir ${id}⟩\n`);
  return text;
}

const MAX_OUTPUT = 1500;

/** A Jupyter notebook as readable text: Markdown cells, code cells, short text outputs (images dropped). */
export function notebookText(json: string): string {
  let nb: { cells?: { cell_type: string; source: string | string[]; outputs?: Record<string, unknown>[] }[]; metadata?: { kernelspec?: { language?: string } } };
  try {
    nb = JSON.parse(json);
  } catch {
    return json.slice(0, 20000);
  }
  const lang = nb.metadata?.kernelspec?.language ?? "python";
  const join = (x: unknown) => (Array.isArray(x) ? x.join("") : typeof x === "string" ? x : "");
  const parts: string[] = [];
  for (const [i, cell] of (nb.cells ?? []).entries()) {
    const src = join(cell.source).trim();
    if (cell.cell_type === "markdown") {
      if (src) parts.push(src);
      continue;
    }
    if (cell.cell_type !== "code") continue;
    parts.push(`\`\`\`${lang}\n# [cellule ${i + 1}]\n${src}\n\`\`\``);
    const outs: string[] = [];
    let images = 0;
    for (const o of cell.outputs ?? []) {
      const data = (o.data ?? {}) as Record<string, unknown>;
      if (o.output_type === "stream") outs.push(join(o.text));
      else if (o.output_type === "error") outs.push(`${String(o.ename)}: ${String(o.evalue)}`);
      else if (data["text/plain"] !== undefined && !data["image/png"]) outs.push(join(data["text/plain"]));
      if (data["image/png"] || data["image/jpeg"] || data["image/svg+xml"]) images++;
    }
    let out = outs.join("\n").trim();
    if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}\n… (sortie tronquée)`;
    if (out) parts.push(`Sortie :\n\`\`\`\n${out}\n\`\`\``);
    if (images) parts.push(`[${images} graphique(s) en sortie]`);
  }
  return parts.join("\n\n");
}

/** The head of a data file: enough to know what it holds, never the whole file. */
export function dataPreview(text: string, size: number, lines = 15): string {
  const head = text.split(/\r?\n/).slice(0, lines).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
  return `Fichier de données (${Math.round(size / 1024)} Ko), premières lignes :\n${head.join("\n")}`;
}
