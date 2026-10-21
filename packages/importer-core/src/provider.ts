import type { PageDocument } from "@thoth/content";
import type { ImportSourceKind, ImportWarning } from "@thoth/domain";
import type { ImportItemKind } from "./manifest.ts";
import type { SourceHost } from "./ports.ts";
import type { ImportSource, SourceEntry } from "./source.ts";

export interface ClassifiedEntry {
  sourcePath: string;
  kind: ImportItemKind;
  /** Proposed destination path relative to the destination root (before collision handling). */
  relDest?: string;
  sourceId?: string;
  warnings?: ImportWarning[];
}

/**
 * Provider-specific behavior plugged into the shared pipeline (spec §7.4).
 * Providers never touch the vault or the source directly.
 */
export interface ImportProvider {
  readonly system: "notion" | "obsidian";
  readonly sourceKind: ImportSourceKind;
  /** Classifies source entries (paths already stripped of any wrapper folder). */
  classify(entries: readonly SourceEntry[]): ClassifiedEntry[];
  /** Reports unsupported or lossy constructs in a parsed page. */
  analyzePage(doc: PageDocument, sourcePath: string): ImportWarning[];
  /** Validates non-page files such as database CSVs (optional). */
  analyzeFile?(sourcePath: string, bytes: Uint8Array): ImportWarning[];
  /** Wrapper folder to strip from every source path, e.g. a zipped vault folder (optional). */
  rootPrefix?(paths: readonly string[]): string;
}

export interface OpenedImport {
  source: ImportSource;
  provider: ImportProvider;
}

/**
 * A named adapter (spec §7.4) pairing a source opener with a provider. The
 * main package entries export host-based importers that run anywhere (Tauri
 * webview included); the `./node` entries add `open(location)` on top.
 */
export interface HostImporter<Limits = unknown> {
  readonly id: "NotionZipImporter" | "NotionMarkdownCsvImporter" | "ObsidianVaultImporter" | "ObsidianZipImporter";
  readonly sourceKind: ImportSourceKind;
  /** Whether `openHost` needs a host bound to a chosen file (an archive) or a folder. */
  readonly hostKind: SourceHost["rootKind"];
  /**
   * Opens a source through a platform `SourceHost` and takes ownership of it:
   * the host is closed with the source, or at once if opening fails
   * (including when the host is the wrong kind).
   */
  openHost(host: SourceHost, limits?: Limits): Promise<OpenedImport>;
}

/** A host importer plus the Node convenience of opening a path directly. */
export interface Importer<Limits = unknown> extends HostImporter<Limits> {
  open(location: string, limits?: Limits): Promise<OpenedImport>;
}
