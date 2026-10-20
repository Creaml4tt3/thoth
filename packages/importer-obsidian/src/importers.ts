import { openDirectorySource, openZipSource } from "@thoth/importer-core/node";
import type { Importer, ScanLimits } from "@thoth/importer-core";
import { obsidianProvider, zippedVaultRoot } from "./index.ts";

export const ObsidianVaultImporter: Importer<Partial<ScanLimits>> = {
  id: "ObsidianVaultImporter",
  sourceKind: "obsidian-vault",
  async open(location, limits) {
    return { source: await openDirectorySource(location, limits), provider: obsidianProvider() };
  },
};

export const ObsidianZipImporter: Importer<Partial<ScanLimits>> = {
  id: "ObsidianZipImporter",
  sourceKind: "obsidian-zip",
  async open(location, limits) {
    return { source: await openZipSource(location, limits), provider: { ...obsidianProvider(), sourceKind: "obsidian-zip", rootPrefix: zippedVaultRoot } };
  },
};
