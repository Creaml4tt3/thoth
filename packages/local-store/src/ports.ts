/**
 * Platform ports (ADR-008). Domain logic talks to the filesystem and SQLite
 * only through these interfaces so the same code can run on Node (tests, CLI)
 * and behind Tauri commands (desktop).
 *
 * All paths are vault-relative POSIX paths; implementations must refuse any
 * path that escapes the vault root.
 */
export type EntryKind = "file" | "directory" | "symlink" | "other";

export interface FileStat {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  kind: EntryKind;
}

export interface VaultFs {
  stat(path: string): Promise<FileStat | undefined>;
  readFile(path: string): Promise<Uint8Array>;
  list(dir: string): Promise<DirEntry[]>;
  mkdirp(dir: string): Promise<void>;
  /** Writes and fsyncs. Fails if the file exists when `exclusive` is set. */
  writeFile(path: string, data: Uint8Array, options?: { exclusive?: boolean }): Promise<void>;
  /** Atomic rename within the vault volume. Replaces `to` unless `noReplace`, in which case an existing target fails with an error whose `code` is "EEXIST". */
  rename(from: string, to: string, options?: { noReplace?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
}

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  get<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  close(): Promise<void>;
}
