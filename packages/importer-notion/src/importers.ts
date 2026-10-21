import type { Importer, ScanLimits } from "@thoth/importer-core";
import { openNodeSourceHost } from "@thoth/importer-core/node";
import * as hostImporters from "./host-importers.ts";

/** Node entry: the host importers plus `open(location)`, which opens a Node `SourceHost` for the path. */
export const NotionZipImporter: Importer<Partial<ScanLimits>> = {
  ...hostImporters.NotionZipImporter,
  async open(location, limits) {
    return hostImporters.NotionZipImporter.openHost(await openNodeSourceHost(location), limits);
  },
};

export const NotionMarkdownCsvImporter: Importer<Partial<ScanLimits>> = {
  ...hostImporters.NotionMarkdownCsvImporter,
  async open(location, limits) {
    return hostImporters.NotionMarkdownCsvImporter.openHost(await openNodeSourceHost(location), limits);
  },
};
