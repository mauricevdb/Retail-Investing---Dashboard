import { VaultFile } from "./core/types";

/** Everything the engine needs from the vault. Implemented on top of Obsidian, and on node:fs for tests. */
export interface VaultIO {
  listFiles(): VaultFile[];
  listFolders(): string[];
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  /** Creates the file (parent folders included); fails if it exists. */
  create(path: string, content: string): Promise<void>;
  /** Overwrites an existing file. */
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Removes a folder only if it is empty. */
  rmdirIfEmpty(path: string): Promise<void>;
  /** Moves/renames a file or folder; in Obsidian this also rewrites the links pointing to it. */
  move(from: string, to: string): Promise<void>;
  /** Sends a file to the trash (system trash when possible). */
  trash(path: string): Promise<void>;
  /** Absolute path on disk, when the vault lives on a file system (desktop). */
  absolutePath(path: string): string | null;
  /** Text layer of the first pages of a PDF; null if it cannot be extracted. */
  pdfText(path: string, pages: number): Promise<{ text: string; pageCount: number } | null>;
  /** Image or PDF as base64, downscaled for images; null if not sendable. */
  binaryPayload(path: string): Promise<{ mediaType: string; base64: string } | null>;
  /** Subscribes to renames (whoever made them). */
  onRename(cb: (from: string, to: string) => void): void;
}
