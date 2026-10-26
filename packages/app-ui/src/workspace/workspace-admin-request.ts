/**
 * "New workspace…", "Recently deleted…", and renaming or deleting a workspace (ADR-0025) as something the app can ask
 * for from anywhere (the command palette), like `requestMembers`: the server's sidebar section serves the first two,
 * the workspace's row the others. A request nobody can serve is dropped; nothing is queued.
 */
import { useSyncExternalStore } from "react";

export type WorkspaceAdminRequest = { kind: "new" | "deleted"; server: string } | { kind: "rename" | "delete"; server: string; workspace: string };

let current: WorkspaceAdminRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};

export function requestWorkspaceAdmin(request: WorkspaceAdminRequest): void {
  current = request;
  emit();
}

export function clearWorkspaceAdmin(): void {
  if (current === null) return;
  current = null;
  emit();
}

const read = () => current;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The pending server-level request ("new" or "deleted") for this server. */
export function usePendingServerAdmin(server: string): (WorkspaceAdminRequest & { kind: "new" | "deleted" }) | null {
  const request = useSyncExternalStore(subscribe, read, read);
  return request !== null && request.server === server && (request.kind === "new" || request.kind === "deleted") ? request : null;
}

/** The pending rename or delete for this workspace. */
export function usePendingWorkspaceAdmin(server: string, workspace: string): (WorkspaceAdminRequest & { kind: "rename" | "delete" }) | null {
  const request = useSyncExternalStore(subscribe, read, read);
  return request !== null && request.server === server && (request.kind === "rename" || request.kind === "delete") && request.workspace === workspace ? request : null;
}

/**
 * What a workspace change says to screen readers when the row that made it is gone (a deleted workspace leaves the
 * sidebar): the server section's live region reads it. One message per server; the latest wins.
 */
let said: { server: string; text: string; n: number } | null = null;
let counter = 0;
const saidListeners = new Set<() => void>();

export function announceWorkspaces(server: string, text: string): void {
  said = { server, text, n: ++counter };
  for (const listener of [...saidListeners]) listener();
}

const readSaid = () => said;
const subscribeSaid = (listener: () => void) => {
  saidListeners.add(listener);
  return () => void saidListeners.delete(listener);
};

/** The latest announcement for this server ("" when there is none). */
export function useWorkspaceAnnouncement(server: string): string {
  const latest = useSyncExternalStore(subscribeSaid, readSaid, readSaid);
  return latest !== null && latest.server === server ? latest.text : "";
}
