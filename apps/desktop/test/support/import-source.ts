/** Test-only `openImportSource`: the existing Node importers, never used by the app itself. */
import { NotionMarkdownCsvImporter, NotionZipImporter } from "@thoth/importer-notion/node";
import { ObsidianVaultImporter, ObsidianZipImporter } from "@thoth/importer-obsidian/node";
import type { ImportSource } from "@thoth/importer-core";
import type { OpenImportSource, OpenedSource } from "../../src/features/import/open-source.ts";

export const nodeOpenImportSource: OpenImportSource = (_platform, kind, location) => {
  const importer = { "notion-zip": NotionZipImporter, "notion-folder": NotionMarkdownCsvImporter, "obsidian-vault": ObsidianVaultImporter, "obsidian-zip": ObsidianZipImporter }[kind];
  return importer.open(location);
};

export interface Gate {
  /** Resolves when the gated read has been reached. */
  reached: Promise<void>;
  release(): void;
  /** How many sources were opened through this gate. */
  opened(): number;
  open: OpenImportSource;
}

/**
 * Holds the first read of a non-page file (only the run phase reads those:
 * planning streams them), so a test can click Cancel while a run is in flight.
 * Only the first opened source after `arm()` is gated; later ones (resume) are not.
 */
export function createGate(): Gate & { arm(): void } {
  let armed = false;
  let fired = false;
  let opened = 0;
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const hold = new Promise<void>((r) => (release = r));
  return {
    reached,
    release,
    arm: () => void (armed = true),
    opened: () => opened,
    async open(platform, kind, location): Promise<OpenedSource> {
      opened++;
      const opened_ = await nodeOpenImportSource(platform, kind, location);
      if (!armed) return opened_;
      const inner = opened_.source;
      const source = Object.create(inner, {
        read: {
          value: async (path: string) => {
            if (!fired && !path.endsWith(".md")) {
              fired = true;
              reach();
              await hold;
            }
            return inner.read(path);
          },
        },
      }) as ImportSource;
      return { source, provider: opened_.provider };
    },
  };
}
