/**
 * "Move to…" as something the app can ask for from anywhere. The tree that owns the page listens and opens its
 * destination dialog, so the command palette (later) only needs to call `requestMoveTo` with the open page:
 *
 *     requestMoveTo({ kind: "private", path: "Projects/Plan.md" });
 *     requestMoveTo({ kind: "workspace", server, workspace, page });
 *
 * A request nobody can serve (the tree is not on screen, the page is read-only) is dropped by the tree that
 * receives it and leaves a note there; nothing is queued.
 */
import { useSyncExternalStore } from "react";

export type MoveToRequest = { kind: "private"; path: string } | { kind: "workspace"; server: string; workspace: string; page: string };

let current: MoveToRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};

export function requestMoveTo(request: MoveToRequest): void {
  current = request;
  emit();
}

export function clearMoveTo(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function currentMoveTo(): MoveToRequest | null {
  return current;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The pending request, if `accepts` says it belongs to the caller. */
export function usePendingMoveTo<T extends MoveToRequest>(accepts: (request: MoveToRequest) => request is T): T | null {
  const request = useSyncExternalStore(subscribe, currentMoveTo, currentMoveTo);
  return request !== null && accepts(request) ? request : null;
}
