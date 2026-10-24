import { ConflictError, readOrder, renameInOrder, writeOrder } from "@thoth/local-store";
import { basename, dirname, isReservedPath, stripExtension } from "@thoth/domain";
import { PAGE_TITLE_MAX } from "@thoth/workspace-protocol";
import { RenameDialog } from "@thoth/app-ui/order/RenameDialog.tsx";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { useSession } from "../../app/context.ts";

export type RenameTarget = { kind: "private"; path: string } | { kind: "workspace"; server: string; workspace: string; page: string; title: string };

const join = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);

/**
 * "Rename page" from the palette. A Private Space page is renamed by moving its file inside the vault, which follows
 * the links to it (`Vault.move`) and keeps its place in the order record; a workspace page changes its title on the server.
 */
export function RenamePage({ target, onClose }: { target: RenameTarget; onClose(): void }) {
  const { vault, openPage, refresh, flushAll, servers } = useSession();
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

  const file = basename(target.path);
  const extension = file.slice(stripExtension(file).length);
  return (
    <RenameDialog
      name={stripExtension(file)}
      onClose={onClose}
      onRename={async (next) => {
        if (/[\\/]/.test(next) || next === "." || next === "..") return t.renameDialog.invalid;
        const to = join(dirname(target.path), `${next}${extension}`);
        if (isReservedPath(to)) return t.renameDialog.invalid;
        try {
          // Unsaved edits are written first: the file moves with everything the user typed.
          if (!(await flushAll())) return "";
          const report = await vault.move(target.path, to);
          const order = await readOrder(vault);
          const moved = renameInOrder(order, report.moved);
          if (JSON.stringify(moved) !== JSON.stringify(order)) await writeOrder(vault, moved); // no order file appears just for a rename
          await refresh();
          openPage(to);
          return null;
        } catch (error) {
          return error instanceof ConflictError ? t.renameDialog.exists : t.renameFailed(error instanceof Error ? error.message : String(error));
        }
      }}
    />
  );
}
