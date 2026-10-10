// Bridge to the local Claude Code CLI, in the spirit of pi-claude-bridge: the plugin drives
// `claude -p` as a subprocess, so requests run on the user's Claude subscription (or whatever
// auth Claude Code is set up with) and Claude reads PDFs and photos straight from the vault with
// its own Read tool. The process only gets read access: it can never write to the vault.
import type { ChildProcess } from "child_process";
import { LlmBackend, LlmError, LlmRequest } from "./types";

type NodeRequire = (id: string) => unknown;
const nodeRequire = (id: string) => (globalThis as { require?: NodeRequire }).require?.(id) ?? require(id);

interface CliResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
}

export class ClaudeCodeBackend implements LlmBackend {
  readonly name = "Claude Code";
  private resolved: { bin: string; prefix: string[]; env: NodeJS.ProcessEnv } | null = null;

  constructor(
    private readonly vaultPath: string,
    private readonly opts: () => { claudePath: string; timeoutSec: number },
  ) {}

  /** Forget the cached binary (after a settings change). */
  reset() {
    this.resolved = null;
  }

  async check(): Promise<string | null> {
    try {
      const { bin, prefix, env } = await this.resolve();
      const out = await this.run(bin, [...prefix, "--version"], "", env, 30_000);
      return /claude/i.test(out) ? null : `Réponse inattendue de ${bin} : ${out.slice(0, 200)}`;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async complete<T>(req: LlmRequest): Promise<T> {
    const { bin, prefix, env } = await this.resolve();
    const reads = req.attachments?.length ? req.attachments : [];
    const args = [
      ...prefix,
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(req.schema),
      "--model",
      req.model,
      "--effort",
      req.effort,
      "--system-prompt",
      req.system,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      ...(reads.length ? ["--tools", "Read", "--allowedTools", "Read", "--add-dir", this.vaultPath] : ["--tools", ""]),
    ];
    let prompt = req.prompt;
    if (reads.length) {
      prompt += `\n\nFichiers à lire avec l'outil Read (chemins absolus) :\n${reads.map((a) => `- ${a.path} → ${a.absPath}`).join("\n")}`;
    }
    const raw = await this.run(bin, args, prompt, env, this.opts().timeoutSec * 1000, req.signal);
    let parsed: CliResult;
    try {
      parsed = JSON.parse(raw.trim().split("\n").pop() ?? "");
    } catch {
      throw new LlmError(`Sortie illisible de Claude Code (${req.label}) : ${raw.slice(0, 300)}`);
    }
    if (parsed.is_error || parsed.subtype !== "success") {
      throw new LlmError(`Claude Code a échoué (${req.label}) : ${parsed.result ?? parsed.subtype}`);
    }
    if (parsed.structured_output !== undefined && parsed.structured_output !== null) return parsed.structured_output as T;
    try {
      return JSON.parse(parsed.result ?? "") as T;
    } catch {
      throw new LlmError(`Claude Code n'a pas renvoyé de JSON (${req.label}).`);
    }
  }

  private run(bin: string, args: string[], input: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const { spawn } = nodeRequire("child_process") as typeof import("child_process");
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, { cwd: this.vaultPath, env, windowsHide: true });
      } catch (e) {
        reject(new LlmError(`Impossible de lancer ${bin} : ${(e as Error).message}`));
        return;
      }
      let out = "";
      let err = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new LlmError(`Claude Code n'a pas répondu en ${Math.round(timeoutMs / 1000)} s.`)));
      }, timeoutMs);
      const onAbort = () => {
        child.kill();
        finish(() => reject(new LlmError("Annulé.")));
      };
      signal?.addEventListener("abort", onAbort);
      child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
      child.on("error", (e) => finish(() => reject(new LlmError(`Impossible de lancer ${bin} : ${e.message}`))));
      child.on("close", (code) =>
        finish(() => {
          // With --output-format json, failures still print a JSON result on stdout.
          if (code === 0 || out.trim().startsWith("{")) resolve(out);
          else reject(new LlmError(`Claude Code s'est arrêté (code ${code}) : ${(err || out).slice(0, 500)}`));
        }),
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input, "utf8");
    });
  }

  /**
   * Finds the executable. GUI apps on macOS do not inherit the shell PATH, so we ask the login
   * shell, then try the usual install locations. On Windows an npm `claude.cmd` shim cannot take
   * JSON arguments safely, so we run its cli.js with node directly.
   */
  private async resolve() {
    if (this.resolved) return this.resolved;
    const fs = nodeRequire("fs") as typeof import("fs");
    const path = nodeRequire("path") as typeof import("path");
    const os = nodeRequire("os") as typeof import("os");
    const { spawnSync } = nodeRequire("child_process") as typeof import("child_process");
    const win = process.platform === "win32";
    const home = os.homedir();

    let shellPath = process.env.PATH ?? "";
    if (!win) {
      const shell = process.env.SHELL || "/bin/zsh";
      const r = spawnSync(shell, ["-lc", "echo __PATH__$PATH"], { encoding: "utf8", timeout: 5000 });
      const m = /__PATH__(.*)/.exec(r.stdout ?? "");
      if (m) shellPath = `${m[1].trim()}${path.delimiter}${shellPath}`;
    }
    const extra = win
      ? [path.join(home, ".local", "bin"), path.join(process.env.APPDATA ?? "", "npm")]
      : [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin"), path.join(home, ".bun", "bin")];
    const PATH = [...shellPath.split(path.delimiter), ...extra].filter(Boolean).join(path.delimiter);
    const env = { ...process.env, PATH };

    const names = win ? ["claude.exe", "claude.cmd"] : ["claude"];
    const configured = this.opts().claudePath.trim();
    let bin = configured;
    if (!bin) {
      for (const dir of PATH.split(path.delimiter)) {
        const hit = names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
        if (hit) {
          bin = hit;
          break;
        }
      }
    }
    if (!bin || (configured && !fs.existsSync(configured))) {
      throw new LlmError(
        "Exécutable « claude » introuvable. Installez Claude Code (https://code.claude.com), connectez-vous avec `claude`, ou indiquez son chemin dans les réglages.",
      );
    }
    let prefix: string[] = [];
    if (win && bin.toLowerCase().endsWith(".cmd")) {
      const cli = path.join(path.dirname(bin), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (!fs.existsSync(cli)) throw new LlmError("Sous Windows, installez Claude Code avec l'installateur natif (claude.exe).");
      prefix = [cli];
      bin = "node";
    }
    this.resolved = { bin, prefix, env };
    return this.resolved;
  }
}
