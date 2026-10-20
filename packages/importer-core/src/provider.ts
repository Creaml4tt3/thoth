import type { PageDocument } from "@thoth/content";
import type { ImportSourceKind, ImportWarning } from "@thoth/domain";
import type { ImportItemKind } from "./manifest.ts";
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

/** A named adapter (spec §7.4) pairing a source opener with a provider. */
export interface Importer<Limits = unknown> {
  readonly id: "NotionZipImporter" | "NotionMarkdownCsvImporter" | "ObsidianVaultImporter" | "ObsidianZipImporter";
  readonly sourceKind: ImportSourceKind;
  open(location: string, limits?: Limits): Promise<{ source: ImportSource; provider: ImportProvider }>;
}
