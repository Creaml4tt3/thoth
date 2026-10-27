import { roleCan } from "@thoth/workspace-protocol";
import type { SpaceDrag, SpaceDrop } from "../order/space-drag.ts";
import type { ServerDirectory } from "../workspace/directory.ts";
import type { TransferTarget } from "./TransferDialog.tsx";

/**
 * Whether there is another workspace than `here`, on any server the person is signed in to, that takes pages: then
 * "Copy / Move to another workspace…" is offered (ADR-0006, amendment of 2026-10-27).
 */
export function hasOtherWritableWorkspace(state: ReturnType<ServerDirectory["getState"]>, here: { server: string; workspace: string }): boolean {
  return state.servers.some((s) => s.info.auth !== "signed-out" && (s.workspaces ?? []).some((w) => !(s.info.id === here.server && w.id === here.workspace) && roleCan(w.role, "write")));
}

/** The dialog for a workspace page (and what it carries) going to another workspace; `to` prefills the destination. */
export function betweenTarget(drag: SpaceDrag, mode: "copy" | "move", to?: { server: string; workspace: string; parentId: string | null }): TransferTarget | null {
  if (drag.from.kind !== "workspace") return null;
  return { direction: "between_workspaces", server: drag.from.server, workspace: drag.from.workspace, pageId: drag.row, pageIds: drag.ids, title: drag.title, mode, ...(to ? { to } : {}) };
}

/** The dialog a drop of a workspace page on another workspace opens; null for any other drop. */
export function betweenTargetFor({ drag, to, mode }: SpaceDrop): TransferTarget | null {
  if (drag.from.kind !== "workspace" || to.kind !== "workspace" || (drag.from.server === to.server && drag.from.workspace === to.workspace)) return null;
  return betweenTarget(drag, mode, { server: to.server, workspace: to.workspace, parentId: to.parentId });
}
