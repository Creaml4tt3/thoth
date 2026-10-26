/**
 * The desktop's side of dragging pages between the Private Space and a workspace (ADR-0006, amendment of
 * 2026-10-26; the shared part is `@thoth/app-ui/order/space-drag.ts`): what a workspace page may do over the
 * Private Space, and which transfer dialog a drop opens.
 */
import type { AcrossTarget } from "@thoth/app-ui/order/dnd.ts";
import { crossDirection, refusalText, spaceDropRefusal, workspaceAccess, type SpaceDrag, type SpaceDrop } from "@thoth/app-ui/order/space-drag.ts";
import type { Strings } from "@thoth/app-ui/strings/index.ts";
import type { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import type { TransferTarget } from "../transfer/TransferDialog.tsx";

export const PRIVATE_SPACE = { kind: "private" } as const;

/**
 * A drag over the Private Space that would land in `folder` ("" is the top level), lighting `highlight` (a folder
 * row; null when the header is lit). Null when the drag is not from a workspace.
 */
export function privateAcross(servers: ServerDirectory, drag: SpaceDrag, folder: string, highlight: string | null, move: boolean, s: Strings["tree"]["across"]): AcrossTarget | null {
  if (drag.from.kind !== "workspace" || crossDirection(drag.from, PRIVATE_SPACE) !== "from_workspace") return null;
  const access = workspaceAccess(servers, drag.from.server, drag.from.workspace);
  const refusal = spaceDropRefusal("from_workspace", access);
  if (refusal) return { highlight: null, to: null, text: refusalText(refusal, access, s) };
  return { highlight, to: { kind: "private", folder }, text: (move ? s.moveTo : s.copyTo)(s.privateSpace) };
}

/** The transfer dialog a drop opens, prefilled; null for a drop that is not across spaces. */
export function transferTargetFor({ drag, to, mode }: SpaceDrop): TransferTarget | null {
  if (drag.from.kind === "private" && to.kind === "workspace")
    return { direction: "to_workspace", paths: drag.ids, mode, server: to.server, workspace: to.workspace, parentId: to.parentId, ...(drag.base !== undefined ? { base: drag.base } : {}) };
  if (drag.from.kind === "workspace" && to.kind === "private")
    return { direction: "from_workspace", server: drag.from.server, workspace: drag.from.workspace, pageId: drag.row, pageIds: drag.ids, title: drag.title, mode, folder: to.folder };
  return null;
}
