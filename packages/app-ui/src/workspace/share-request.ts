/**
 * "Share…" as something the app can ask for from anywhere (the command palette), like `requestMoveTo`: the workspace
 * tree that holds the page listens and opens its share dialog. A request nobody can serve (the server lacks
 * `public-share`, the user is a viewer, the page is not in that tree) is dropped; nothing is queued.
 */
import { useSyncExternalStore } from "react";

export interface ShareRequest {
  server: string;
  workspace: string;
  page: string;
}

let current: ShareRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};

export function requestShare(request: ShareRequest): void {
  current = request;
  emit();
}

export function clearShare(): void {
  if (current === null) return;
  current = null;
  emit();
}

const read = () => current;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The pending request for this workspace, if there is one. */
export function usePendingShare(server: string, workspace: string): ShareRequest | null {
  const request = useSyncExternalStore(subscribe, read, read);
  return request !== null && request.server === server && request.workspace === workspace ? request : null;
}
