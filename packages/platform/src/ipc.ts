/**
 * Command contract between the TypeScript ports and the native host (ADR-008).
 *
 * One dispatch table is implemented in Rust (`crates/thoth-host`) and exposed
 * through Tauri commands (desktop) and a stdio harness (port contract tests and
 * the e2e dev bridge). TypeScript reaches it only through a `Transport`, so the
 * same `Remote*` port adapters run over every transport.
 *
 * Bytes travel out of band (a raw IPC body, or base64 on stdio), never as JSON
 * arrays of numbers. The webview is untrusted: the host only opens vault roots
 * and import sources that the user picked in a native dialog (or reopened from
 * the host's own recent list), and every path argument is vault- or
 * source-relative.
 */
import type { DirEntry, FileStat } from "@thoth/local-store";
import type { SourceDirEntry } from "@thoth/importer-core";

/** SQL values on the wire. Integers outside ±2^53 and blobs are tagged. */
export type WireValue = null | string | number | { $bigint: string } | { $bytes: string };
export type WireRow = Record<string, WireValue>;

/**
 * Error codes a host returns as `{ code, message }`. File-system codes match
 * POSIX errno names because `@thoth/local-store` checks `error.code`.
 */
export type HostErrorCode =
  | "EEXIST"
  | "ENOENT"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOTEMPTY"
  | "EACCES"
  | "EIO"
  | "UNSAFE_PATH"
  | "NOT_ALLOWED"
  | "NOT_A_REGULAR_FILE"
  | "BAD_HANDLE"
  | "BAD_ARGUMENT"
  | "SQLITE_ERROR"
  | "SQLITE_BUSY"
  | "SQLITE_CONSTRAINT"
  | "INTERNAL";

export interface HostError {
  code: HostErrorCode;
  message: string;
}

export interface VaultChangedEvent {
  vault: string;
  /** Vault-relative paths that changed; may be empty when `rescan` is set. */
  paths: string[];
  /** The watcher lost events (overflow, root moved); the client must run a full reconcile. */
  rescan: boolean;
}

type Bytes = Uint8Array;

export interface Commands {
  "vault.pick": { args: Record<string, never>; result: string | null };
  "vault.recent": { args: Record<string, never>; result: string[] };
  "vault.open": { args: { root: string }; result: { vault: string; root: string; label: string } };
  "vault.close": { args: { vault: string }; result: null };

  "fs.stat": { args: { vault: string; path: string }; result: FileStat | null };
  "fs.read": { args: { vault: string; path: string }; result: Bytes };
  "fs.list": { args: { vault: string; dir: string }; result: DirEntry[] };
  "fs.mkdirp": { args: { vault: string; dir: string }; result: null };
  /** Request bytes: the file content. */
  "fs.write": { args: { vault: string; path: string; exclusive: boolean }; result: null };
  "fs.rename": { args: { vault: string; from: string; to: string; noReplace: boolean }; result: null };
  "fs.remove": { args: { vault: string; path: string }; result: null };

  "sql.exec": { args: { vault: string; sql: string }; result: null };
  "sql.run": { args: { vault: string; sql: string; params: WireValue[] }; result: { changes: number } };
  "sql.all": { args: { vault: string; sql: string; params: WireValue[] }; result: WireRow[] };
  "sql.get": { args: { vault: string; sql: string; params: WireValue[] }; result: WireRow | null };

  /** Emits `vault.changed` events until stopped or the vault is closed. */
  "watch.start": { args: { vault: string }; result: null };
  "watch.stop": { args: { vault: string }; result: null };

  "source.pick": { args: { kind: "file" | "directory" }; result: string | null };
  "source.open": { args: { location: string }; result: { source: string; rootKind: "file" | "directory"; label: string; location: string } };
  "source.list": { args: { source: string; dir: string }; result: SourceDirEntry[] };
  "source.file.open": { args: { source: string; path: string }; result: { file: string; size: number } };
  "source.file.read": { args: { file: string; position: number; length: number }; result: Bytes };
  "source.file.close": { args: { file: string }; result: null };
  "source.temp.create": { args: { source: string }; result: { file: string } };
  /** Request bytes: the data to write at `position`. */
  "source.temp.write": { args: { file: string; position: number }; result: null };
  "source.close": { args: { source: string }; result: null };
}

export type CommandName = keyof Commands;

export interface Transport {
  call<C extends CommandName>(command: C, args: Commands[C]["args"], bytes?: Uint8Array): Promise<Commands[C]["result"]>;
  listen(event: "vault.changed", handler: (payload: VaultChangedEvent) => void): Promise<() => void>;
}
