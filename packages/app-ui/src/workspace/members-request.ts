/**
 * "Members…" as something the app can ask for from anywhere (the command palette), like `requestShare`: the sidebar's
 * row of that workspace listens and opens its members dialog. A request nobody can serve (the server lacks `members`,
 * the workspace is not in the sidebar) is dropped; nothing is queued.
 */
import { useSyncExternalStore } from "react";

export interface MembersRequest {
  server: string;
  workspace: string;
}

let current: MembersRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};

export function requestMembers(request: MembersRequest): void {
  current = request;
  emit();
}

export function clearMembers(): void {
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
export function usePendingMembers(server: string, workspace: string): MembersRequest | null {
  const request = useSyncExternalStore(subscribe, read, read);
  return request !== null && request.server === server && request.workspace === workspace ? request : null;
}
