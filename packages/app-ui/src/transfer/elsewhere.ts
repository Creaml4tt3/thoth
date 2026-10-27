import { roleCan } from "@thoth/workspace-protocol";
import type { ServerDirectory } from "../workspace/directory.ts";

/**
 * Whether there is another workspace than `here`, on any server the person is signed in to, that takes pages: then
 * "Copy / Move to another workspace…" is offered (ADR-0006, amendment of 2026-10-27).
 */
export function hasOtherWritableWorkspace(state: ReturnType<ServerDirectory["getState"]>, here: { server: string; workspace: string }): boolean {
  return state.servers.some((s) => s.info.auth !== "signed-out" && (s.workspaces ?? []).some((w) => !(s.info.id === here.server && w.id === here.workspace) && roleCan(w.role, "write")));
}
