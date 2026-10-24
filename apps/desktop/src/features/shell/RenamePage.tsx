import { basename, stripExtension } from "@thoth/domain";
import { PAGE_TITLE_MAX } from "@thoth/workspace-protocol";
import { RenameDialog } from "@thoth/app-ui/order/RenameDialog.tsx";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { useSession } from "../../app/context.ts";
import { RenameError, renamePrivate, renameProblemText } from "./rename.ts";

export type RenameTarget = { kind: "private"; path: string } | { kind: "workspace"; server: string; workspace: string; page: string; title: string };

/**
 * "Rename page" from the palette. A Private Space page is renamed by moving its file inside the vault (`renamePrivate`,
 * the same change as F2 in the tree), which follows the links to it and keeps its place in the order record; a
 * workspace page changes its title on the server.
 */
export function RenamePage({ target, onClose }: { target: RenameTarget; onClose(): void }) {
  const { vault, refresh, flushAll, servers, tabs } = useSession();
  const t = useStrings().tree;

  if (target.kind === "workspace") {
    return (
      <RenameDialog
        name={target.title}
        maxLength={PAGE_TITLE_MAX}
        onClose={onClose}
        onRename={async (next) => {
          try {
            await servers.renamePage(target.server, target.workspace, target.page, next);
            return null;
          } catch (error) {
            return t.renameFailed(error instanceof Error ? error.message : String(error));
          }
        }}
      />
    );
  }

  return (
    <RenameDialog
      name={stripExtension(basename(target.path))}
      onClose={onClose}
      onRename={async (next) => {
        try {
          // Unsaved edits are written first: the file moves with everything the user typed.
          if (!(await flushAll())) return "";
          // Same rule as the tree's F2 rename: a title that was the old name follows the new one; any other text is left alone.
          const renamed = await renamePrivate(vault, target.path, next, { retitle: true });
          tabs.remapPaths(renamed.from, renamed.to);
          await refresh();
          return null;
        } catch (error) {
          return error instanceof RenameError ? renameProblemText(error.problem, t) : t.renameFailed(error instanceof Error ? error.message : String(error));
        }
      }}
    />
  );
}
