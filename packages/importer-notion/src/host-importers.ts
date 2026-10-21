import { openArchiveSource, openFolderSource, type HostImporter, type ScanLimits } from "@thoth/importer-core";
import { notionProvider } from "./provider.ts";

/** Notion Markdown & CSV export ZIP, including multi-part exports of nested ZIPs. Needs a file host. */
export const NotionZipImporter: HostImporter<Partial<ScanLimits>> = {
  id: "NotionZipImporter",
  sourceKind: "notion-zip",
  hostKind: "file",
  async openHost(host, limits) {
    return { source: await openArchiveSource(host, limits), provider: notionProvider() };
  },
};

/** A Notion export the user already extracted to a folder. Needs a directory host. */
export const NotionMarkdownCsvImporter: HostImporter<Partial<ScanLimits>> = {
  id: "NotionMarkdownCsvImporter",
  sourceKind: "notion-folder",
  hostKind: "directory",
  async openHost(host, limits) {
    return { source: await openFolderSource(host, limits), provider: { ...notionProvider(), sourceKind: "notion-folder" } };
  },
};
