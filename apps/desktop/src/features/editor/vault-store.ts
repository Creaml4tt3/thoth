/** The Private Space side of the shared editor: a vault file as a `PageStore`, and wikilinks from the vault index. */
import { ConflictError, NotFoundError, type Vault } from "@thoth/local-store";
import { conflictCopyPath, type PageStore } from "@thoth/app-ui/editor/page-session.ts";
import { buildLinkLookup, type LinkLookup } from "@thoth/app-ui/editor/links.ts";
import { createLinkSuggester, type LinkSuggester } from "@thoth/app-ui/editor/link-suggest.ts";

export async function loadLinkLookup(vault: Vault, path: string): Promise<{ lookup: LinkLookup; suggester: LinkSuggester }> {
  const [outgoing, pages] = await Promise.all([vault.outgoingLinks(path).catch(() => []), vault.listPages()]);
  return { lookup: buildLinkLookup(path, outgoing, pages), suggester: createLinkSuggester(path, pages) };
}

export function vaultPageStore(vault: Vault, path: string): PageStore {
  return {
    kind: "file",
    async read() {
      try {
        const read = await vault.readPage(path);
        return { source: read.source, hash: read.hash, editable: read.editable };
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    write: (source, expected) => vault.writePage(path, source, { expectedHash: expected }),
    async writeCopy(source, now) {
      for (let attempt = 1; attempt <= 50; attempt++) {
        const copy = conflictCopyPath(path, now, attempt);
        try {
          await vault.writePage(copy, source, { expectedHash: null });
          return { ref: copy, label: copy };
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
        }
      }
      throw new Error("Could not find a free name for the conflict copy");
    },
    isConflict: (error) => error instanceof ConflictError,
  };
}
