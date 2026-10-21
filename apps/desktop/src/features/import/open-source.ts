/**
 * The one place the desktop app turns a picked location into an
 * `ImportSource` + `ImportProvider`: the platform opens a host bound to the
 * file or folder the user picked (ADR-008), and the matching host-based
 * importer reads it with the portable scan policy (ADR-010). Tests inject their
 * own implementation through `AppOptions.openImportSource`.
 */
import type { HostImporter, ImportProvider, ImportSource } from "@thoth/importer-core";
import type { ImportSourceKind } from "@thoth/domain";
import { NotionMarkdownCsvImporter, NotionZipImporter } from "@thoth/importer-notion";
import { ObsidianVaultImporter, ObsidianZipImporter } from "@thoth/importer-obsidian";
import type { Platform } from "@thoth/platform";

export interface OpenedSource {
  source: ImportSource;
  provider: ImportProvider;
}

export type OpenImportSource = (platform: Platform, kind: ImportSourceKind, location: string) => Promise<OpenedSource>;

const IMPORTERS: Record<ImportSourceKind, HostImporter> = {
  "notion-zip": NotionZipImporter,
  "notion-folder": NotionMarkdownCsvImporter,
  "obsidian-vault": ObsidianVaultImporter,
  "obsidian-zip": ObsidianZipImporter,
};

export const openImportSource: OpenImportSource = async (platform, kind, location) => {
  // openHost owns the host from here: it is closed with the source, or at once if opening fails.
  const host = await platform.openImportSource(location);
  return IMPORTERS[kind].openHost(host);
};
