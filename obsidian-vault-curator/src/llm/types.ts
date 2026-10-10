export interface Attachment {
  /** Vault-relative path (what Claude should cite back). */
  path: string;
  /** Absolute path on disk, for the Claude Code backend which reads files itself. */
  absPath: string | null;
  kind: "image" | "pdf";
  /** Lazily loaded payload for the API backend; null when the file cannot be sent. */
  load: () => Promise<{ mediaType: string; base64: string } | null>;
}

export interface LlmRequest {
  label: string;
  system: string;
  prompt: string;
  /** JSON schema of the expected answer (strict-compatible: closed objects, all keys required). */
  schema: Record<string, unknown>;
  model: string;
  effort: "low" | "medium" | "high";
  attachments?: Attachment[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmBackend {
  readonly name: string;
  /** Null when ready, otherwise a human-readable reason. */
  check(): Promise<string | null>;
  complete<T>(req: LlmRequest): Promise<T>;
}

export class LlmError extends Error {}
