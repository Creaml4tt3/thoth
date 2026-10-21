/**
 * Platform port for reading an import source (ADR-008, ADR-010). Archive and
 * folder scanning policy lives in TypeScript once; each runtime only provides
 * scoped, read-only file access through this port: Node for tests and the CLI,
 * Rust Tauri commands on the desktop.
 *
 * Paths are source-relative POSIX paths; "" is the source root. A host is
 * bound to the one file or folder the user chose and must refuse anything
 * outside it.
 */
import type { EntryKind } from "@thoth/local-store";

export interface SourceDirEntry {
  /** Name as stored on disk (may be NFD on some volumes); callers normalize. */
  name: string;
  kind: EntryKind;
  /** Size in bytes for regular files, 0 otherwise. Never follows symlinks. */
  size: number;
}

/** Positional reads from one open file. */
export interface RandomAccessFile {
  /** Size at open time. */
  readonly size: number;
  /** Reads up to `length` bytes at `position`; returns fewer only at end of file. */
  read(position: number, length: number): Promise<Uint8Array>;
  /** Idempotent. */
  close(): Promise<void>;
}

/** A private scratch file for inflating compressed nested archives. */
export interface TempFile extends RandomAccessFile {
  write(position: number, data: Uint8Array): Promise<void>;
}

export interface SourceHost {
  /** "file" when the user chose an archive, "directory" when they chose a folder. */
  readonly rootKind: "file" | "directory";
  /** Display name of the chosen file or folder. */
  readonly label: string;
  /** Opaque location recorded in the manifest so a resumed job can check it reopened the same source. */
  readonly location: string;
  /** Lists a directory under the root without following symlinks (folder sources only). */
  list(dir: string): Promise<SourceDirEntry[]>;
  /**
   * Opens a regular file for reading. Refuses symlinks in any path component
   * (O_NOFOLLOW plus an ancestor check), opens non-blocking so a FIFO cannot
   * hang, and requires a regular file. For an archive source, "" opens the
   * archive itself.
   */
  open(path: string): Promise<RandomAccessFile>;
  /** Creates a private temp file (owner-only, in a fresh owner-only directory), deleted on close. */
  createTemp(): Promise<TempFile>;
  /** Releases every handle and temp file. Idempotent. */
  close(): Promise<void>;
}
