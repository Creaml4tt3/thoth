import { openArchiveSource, openFolderSource, type HostImporter, type ScanLimits } from "@thoth/importer-core";
import { obsidianProvider, zippedVaultRoot } from "./provider.ts";

/** An Obsidian vault folder. Needs a directory host. */
export const ObsidianVaultImporter: HostImporter<Partial<ScanLimits>> = {
  id: "ObsidianVaultImporter",
  sourceKind: "obsidian-vault",
  hostKind: "directory",
  async openHost(host, limits) {
    return { source: await openFolderSource(host, limits), provider: obsidianProvider() };
  },
};

/** A zipped Obsidian vault. Needs a file host. */
export const ObsidianZipImporter: HostImporter<Partial<ScanLimits>> = {
  id: "ObsidianZipImporter",
  sourceKind: "obsidian-zip",
  hostKind: "file",
  async openHost(host, limits) {
    return { source: await openArchiveSource(host, limits), provider: { ...obsidianProvider(), sourceKind: "obsidian-zip", rootPrefix: zippedVaultRoot } };
  },
};
