/**
 * Which window this is (ADR-0019). The first window is "main" (Tauri's window from `tauri.conf.json`); every other one
 * was opened by the app with an address the shell built: `index.html?window=space-…&root=…&tabs=…`, naming its id,
 * the Private Space it shows and the tabs it starts with. The shell checks the same id rule before it makes a window.
 */
export const MAIN_WINDOW = "main";

const WINDOW_ID = /^space-[a-z0-9]{1,32}$/;

export interface Launch {
  /** "main", or the id of a window the app opened. */
  id: string;
  /** The folder to open at once, without the start screen; null: show the start screen. */
  root: string | null;
  /** The tabs to start with (stored form, `serializeTabs`); null: this window's saved tabs. */
  tabs: string | null;
  /** A page of that Private Space the system asked to open (Open With, ADR-0057): opened as a tab once it is open. */
  page?: string;
}

/** A window on one Markdown file the system handed over (ADR-0057): its id and the token the host gave it. */
export interface FileLaunch {
  id: string;
  token: string;
}

const FILE_WINDOW_ID = /^file-[a-z0-9]{1,32}$/;

/** A file window's launch from its address (`?window=file-…&file=<token>`), or null when this is not one. */
export function readFileLaunch(search: string): FileLaunch | null {
  const params = new URLSearchParams(search);
  const id = params.get("window");
  const token = params.get("file");
  return id !== null && FILE_WINDOW_ID.test(id) && token ? { id, token } : null;
}

export const isWindowId = (id: string): boolean => WINDOW_ID.test(id);

/** The launch of this window from its address's query (`location.search`). Anything that does not fit is the main window. */
export function readLaunch(search: string): Launch {
  const params = new URLSearchParams(search);
  const id = params.get("window");
  if (id === null || !isWindowId(id)) return { id: MAIN_WINDOW, root: null, tabs: null };
  const root = params.get("root");
  const tabs = params.get("tabs");
  const page = params.get("page");
  return { id, root: root && root.length > 0 ? root : null, tabs: tabs && tabs.length > 0 ? tabs : null, ...(page ? { page } : {}) };
}

/** A new window id: `space-` and 16 random lowercase letters and digits. */
export function newWindowId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `space-${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
}
