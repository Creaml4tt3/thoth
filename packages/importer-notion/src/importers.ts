import { openDirectorySource, openZipSource } from "@thoth/importer-core/node";
import type { Importer, ScanLimits } from "@thoth/importer-core";
import { notionProvider } from "./index.ts";

/** Notion Markdown & CSV export ZIP, including multi-part exports of nested ZIPs. */
export const NotionZipImporter: Importer<Partial<ScanLimits>> = {
  id: "NotionZipImporter",
  sourceKind: "notion-zip",
  async open(location, limits) {
    return { source: await openZipSource(location, limits), provider: notionProvider() };
  },
};

/** A Notion export the user already extracted to a folder. */
export const NotionMarkdownCsvImporter: Importer<Partial<ScanLimits>> = {
  id: "NotionMarkdownCsvImporter",
  sourceKind: "notion-folder",
  async open(location, limits) {
    return { source: await openDirectorySource(location, limits), provider: { ...notionProvider(), sourceKind: "notion-folder" } };
  },
};
