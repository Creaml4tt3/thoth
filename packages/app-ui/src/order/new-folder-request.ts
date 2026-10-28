/**
 * "New folder" and "New page" in the Private Space as something the app can ask for from anywhere (the shortcut, the
 * command palette, the sidebar buttons). The tree owns the folders and the inline rename that follows, so it listens,
 * creates the folder or page, shows it and puts it in rename. The same shape as `requestMoveTo`:
 *
 *     requestNewFolder();                  // inside the target folder (the last one clicked, 0.2.6), else the top level
 *     requestNewFolder({ parent: "Docs" }); // inside that folder ("" is the top level)
 *     requestNewPage();                    // a page "Untitled", the same way
 *
 * A request nobody serves (the tree is not on screen) is dropped by the tree that receives it; nothing is queued.
 */
import { useSyncExternalStore } from "react";

export interface NewFolderRequest {
  /** A folder (the default) or a page. */
  kind?: "folder" | "page";
  /** The folder to create it in; omitted: the target folder, else the top level. */
  parent?: string;
  /** Tells two identical requests apart, so asking twice creates two folders. */
  nonce: number;
}

let current: NewFolderRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};

export function requestNewFolder(options: { parent?: string } = {}): void {
  current = { ...(options.parent !== undefined ? { parent: options.parent } : {}), nonce: ++seq };
  emit();
}

export function requestNewPage(options: { parent?: string } = {}): void {
  current = { kind: "page", ...(options.parent !== undefined ? { parent: options.parent } : {}), nonce: ++seq };
  emit();
}

export function clearNewFolder(): void {
  if (current === null) return;
  current = null;
  emit();
}

export const currentNewFolder = (): NewFolderRequest | null => current;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function usePendingNewFolder(): NewFolderRequest | null {
  return useSyncExternalStore(subscribe, currentNewFolder, currentNewFolder);
}
