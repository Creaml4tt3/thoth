/**
 * The windows to bring back (ADR-0019): every window the app opened on a Private Space, until the user closes it.
 * When the main window opens that Private Space and no other window has it open, it reopens them, each with its own
 * tabs (`tabs-store.ts`, keyed by the window's id). A window closed while the app runs is forgotten with its tabs;
 * quitting the app forgets nothing, so the windows open at quit come back. Kept in localStorage like the tabs.
 */
import { clearTabs } from "./tabs-store.ts";
import { isWindowId } from "./windows.ts";

export const WINDOWS_KEY = "thoth.desktop.windows";

interface Stored {
  v: 1;
  windows: { id: string; root: string }[];
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(): Stored["windows"] {
  try {
    const data = JSON.parse(storage()?.getItem(WINDOWS_KEY) ?? "null") as Partial<Stored> | null;
    if (!data || data.v !== 1 || !Array.isArray(data.windows)) return [];
    return data.windows.filter((w): w is { id: string; root: string } => typeof w?.id === "string" && isWindowId(w.id) && typeof w.root === "string" && w.root.length > 0);
  } catch {
    return [];
  }
}

function write(windows: Stored["windows"]): void {
  try {
    storage()?.setItem(WINDOWS_KEY, JSON.stringify({ v: 1, windows } satisfies Stored));
  } catch {
    // quota or privacy mode: the windows last for the session
  }
}

/** The window `id` shows the Private Space at `root` (again: it moves there if it showed another). */
export function rememberWindow(id: string, root: string): void {
  if (!isWindowId(id)) return;
  const others = read().filter((w) => w.id !== id);
  write([...others, { id, root }]);
}

/** The window `id` was closed, or left its Private Space: it does not come back, nor do its tabs. */
export function forgetWindow(id: string): void {
  const all = read();
  for (const w of all.filter((w) => w.id === id)) clearTabs(w.root, id);
  if (all.some((w) => w.id === id)) write(all.filter((w) => w.id !== id));
}

/** The ids of the windows to reopen on the Private Space at `root`, in the order they were opened. */
export const windowsOn = (root: string): string[] => read().filter((w) => w.root === root).map((w) => w.id);
