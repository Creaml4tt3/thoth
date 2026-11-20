/**
 * The Private Space to open at launch (ADR-0029, amendment of 2026-11-20): the one the main window last had open. Kept
 * in localStorage; going back to the picker on purpose forgets it, so the next launch shows the picker too.
 */
const KEY = "thoth.desktop.lastSpace";

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadLastSpace(): string | null {
  try {
    const root = storage()?.getItem(KEY);
    return root && root.length <= 4096 ? root : null;
  } catch {
    return null;
  }
}

/** `null` forgets it. */
export function saveLastSpace(root: string | null): void {
  try {
    if (root === null) storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, root);
  } catch {
    // quota or privacy mode: the next launch shows the picker
  }
}
