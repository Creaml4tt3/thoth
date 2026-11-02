/**
 * Duplicate for pages and folders (ADR-0046), the parts both trees share: the copy's name, and "Duplicate" asked for
 * from code (the command palette), the way `move-to.ts` asks for "Move to…".
 */
import { useSyncExternalStore } from "react";
import type { MoveToRequest } from "./move-to.ts";

/** How many names `copyName` tries before it gives up. */
export const COPY_NAME_TRIES = 1000;

/**
 * The copy's name: `label(1)` is "Alpha (copy)", `label(2)` "Alpha (copy 2)"… (`tree.copyName`), the first that
 * `isFree` accepts. Throws when none of the first `COPY_NAME_TRIES` is.
 */
export function copyName(isFree: (candidate: string) => boolean, label: (n: number) => string): string {
  for (let n = 1; n <= COPY_NAME_TRIES; n++) {
    const candidate = label(n);
    if (isFree(candidate)) return candidate;
  }
  throw new Error(`No free name like "${label(1)}"`);
}

export type DuplicateRequest = MoveToRequest;

let current: DuplicateRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const read = () => current;

export function requestDuplicate(request: DuplicateRequest): void {
  current = request;
  emit();
}

export function clearDuplicate(): void {
  if (current === null) return;
  current = null;
  emit();
}

/** The pending request, if `accepts` says it belongs to the caller. */
export function usePendingDuplicate<T extends DuplicateRequest>(accepts: (request: DuplicateRequest) => request is T): T | null {
  const request = useSyncExternalStore(subscribe, read, read);
  return request !== null && accepts(request) ? request : null;
}
