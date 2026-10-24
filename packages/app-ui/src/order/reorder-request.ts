/**
 * "Move page up / down" as something the app can ask for from anywhere, the same way as `requestMoveTo`: the tree that
 * holds the page listens, moves it among its siblings (the same change as Alt+Shift+Up and Down) and clears the
 * request. A request nobody can serve is dropped by the tree that receives it; nothing is queued.
 */
import { useSyncExternalStore } from "react";
import type { MoveToRequest } from "./move-to.ts";

export type ReorderRequest = MoveToRequest & { delta: -1 | 1 };

let current: ReorderRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};

export function requestReorder(page: MoveToRequest, delta: -1 | 1): void {
  current = { ...page, delta };
  emit();
}

export function clearReorder(): void {
  if (current === null) return;
  current = null;
  emit();
}

export const currentReorder = (): ReorderRequest | null => current;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The pending request, if `accepts` says it belongs to the caller. */
export function usePendingReorder<T extends ReorderRequest>(accepts: (request: ReorderRequest) => request is T): T | null {
  const request = useSyncExternalStore(subscribe, currentReorder, currentReorder);
  return request !== null && accepts(request) ? request : null;
}
