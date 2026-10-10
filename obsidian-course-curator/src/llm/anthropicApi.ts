// Direct Claude API backend (API key). Works on mobile too. Photos and scanned PDFs are sent as
// image / document blocks; the answer is constrained with structured outputs.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { LlmBackend, LlmError, LlmRequest } from "./types";

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export class AnthropicApiBackend implements LlmBackend {
  readonly name = "API Claude";

  constructor(private readonly opts: () => { apiKey: string; timeoutSec: number }) {}

  private client() {
    const { apiKey, timeoutSec } = this.opts();
    if (!apiKey.trim()) throw new LlmError("Aucune clé API Claude renseignée dans les réglages.");
    // Obsidian is a browser context; the key stays on this device, in the plugin settings.
    return new Anthropic({ apiKey: apiKey.trim(), dangerouslyAllowBrowser: true, timeout: timeoutSec * 1000, maxRetries: 3 });
  }

  async check(): Promise<string | null> {
    try {
      await this.client().models.list({ limit: 1 });
      return null;
    } catch (e) {
      return describe(e);
    }
  }

  async complete<T>(req: LlmRequest): Promise<T> {
    const content: BetaContentBlockParam[] = [];
    for (const a of req.attachments ?? []) {
      const payload = await a.load();
      if (!payload) continue;
      content.push({ type: "text", text: `Fichier joint : ${a.path}` });
      if (a.kind === "pdf") {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: payload.base64 } });
      } else {
        content.push({
          type: "image",
          source: { type: "base64", media_type: payload.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: payload.base64 },
        });
      }
    }
    content.push({ type: "text", text: req.prompt });

    const fallback = FALLBACK_MODELS.has(req.model);
    let message;
    try {
      const stream = this.client().beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? 32000,
          system: req.system,
          messages: [{ role: "user", content }],
          output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
          ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: req.signal },
      );
      message = await stream.finalMessage();
    } catch (e) {
      throw new LlmError(`${req.label} : ${describe(e)}`);
    }
    if (message.stop_reason === "refusal") throw new LlmError(`${req.label} : Claude a décliné la demande.`);
    if (message.stop_reason === "max_tokens") throw new LlmError(`${req.label} : réponse tronquée (limite de longueur atteinte).`);
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LlmError(`${req.label} : réponse JSON invalide.`);
    }
  }
}

function describe(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "clé API refusée.";
  if (e instanceof Anthropic.PermissionDeniedError) return "cette clé n'a pas accès à ce modèle.";
  if (e instanceof Anthropic.NotFoundError) return "modèle inconnu — vérifiez son identifiant dans les réglages.";
  if (e instanceof Anthropic.RateLimitError) return "limite de débit atteinte, réessayez dans un moment.";
  if (e instanceof Anthropic.APIUserAbortError) return "annulé.";
  if (e instanceof Anthropic.APIConnectionError) return "connexion à l'API impossible.";
  if (e instanceof Anthropic.APIError) return `erreur ${e.status ?? ""} : ${e.message}`;
  return (e as Error)?.message ?? String(e);
}
