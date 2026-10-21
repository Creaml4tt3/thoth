import type { Importer, ScanLimits } from "@thoth/importer-core";
import { openNodeSourceHost } from "@thoth/importer-core/node";
import * as hostImporters from "./host-importers.ts";

/** Node entry: the host importers plus `open(location)`, which opens a Node `SourceHost` for the path. */
export const ObsidianVaultImporter: Importer<Partial<ScanLimits>> = {
  ...hostImporters.ObsidianVaultImporter,
  async open(location, limits) {
    return hostImporters.ObsidianVaultImporter.openHost(await openNodeSourceHost(location), limits);
  },
};

export const ObsidianZipImporter: Importer<Partial<ScanLimits>> = {
  ...hostImporters.ObsidianZipImporter,
  async open(location, limits) {
    return hostImporters.ObsidianZipImporter.openHost(await openNodeSourceHost(location), limits);
  },
};
