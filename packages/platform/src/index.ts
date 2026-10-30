/**
 * What the app shell needs from the host it runs on (ADR-008). Desktop
 * implements it over Tauri; tests implement it over Node ports or the Rust
 * stdio harness. Domain logic (Vault, import pipeline) runs in TypeScript on
 * top of the ports a `Platform` hands out.
 */
import type { AgentHost } from "@thoth/agent-core";
import type { SourceHost } from "@thoth/importer-core";
import type { SqlDriver, VaultFs } from "@thoth/local-store";
import type { ApiCallArgs, ApiCallResult, ConnectedAppsLogEntry, ConnectedAppsSettings, DiagnosticsBundle, InstallState, LinkPreview, McpAnswer, McpRequest, RestartAnswer, ServerInfo, UpdateCheck, UpdateSettings, VaultChangedEvent } from "./ipc.ts";

export type * from "./ipc.ts";

export interface VaultConnection {
  readonly root: string;
  readonly label: string;
  /**
   * Another window of the app already had this folder open when this connection was made (ADR-0019). That window ran
   * the start-up recovery (journal, agent runs, transfers); this one must not, since what it would recover is in flight.
   */
  readonly shared?: boolean;
  readonly fs: VaultFs;
  readonly sql: SqlDriver;
  /** Starts the filesystem watcher. It is a trigger only: listeners should debounce into `vault.reconcile()`. */
  watch(listener: (event: Omit<VaultChangedEvent, "vault">) => void): Promise<() => Promise<void>>;
  /** Is another window on this folder now? Absent where there is only ever one window (it is never shared then). */
  isShared?(): Promise<boolean>;
  /**
   * Shows this folder in Finder, File Explorer or Files; with `path` (vault-relative), that page or folder in it,
   * selected (on Linux, the folder that holds it). Absent where there is no file manager to open.
   */
  reveal?(path?: string): Promise<void>;
  /** Deletes a page or folder (vault-relative) by moving it to the system Trash, where it can be put back from. */
  trash?(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface Platform {
  readonly kind: "tauri" | "bridge" | "node";
  /** Native folder picker. Returns null when the user cancels. */
  pickVaultFolder(): Promise<string | null>;
  recentVaults(): Promise<string[]>;
  /** Opens a vault root the user picked (or one from `recentVaults`); the host refuses any other path. */
  openVault(root: string): Promise<VaultConnection>;
  /** Native picker for an import source: an archive file or a folder. */
  pickImportSource(kind: "file" | "directory"): Promise<string | null>;
  openImportSource(location: string): Promise<SourceHost>;
  /**
   * Native picker for an image to add to a page (ADR-0028): its file name and bytes, or null when cancelled. Absent
   * where the host has none. The page never learns where the file was.
   */
  pickImage?(): Promise<{ name: string; bytes: Uint8Array } | null>;
  /**
   * Download as Markdown: a "Save as" dialog starting with `name`, then `bytes` written where the person chose. True when
   * saved, false when cancelled. Absent where the host has none (the browser downloads instead).
   */
  saveFile?(name: string, bytes: Uint8Array): Promise<boolean>;
  /** Workspace servers. The host holds every credential; the webview only names a server by its handle. */
  readonly servers: Servers;
  /**
   * Agent CLIs on this computer (ADR-0007). Only a native host has them; absent means the Agent Hub is unavailable
   * (a browser can never spawn a process, spec 14.11).
   */
  readonly agents?: AgentHost;
  /** More windows of the app on a Private Space (ADR-0019). Only the desktop shell has them; absent: one window only. */
  readonly windows?: Windows;
  /** Link previews and opening web links (ADR-0020). Only a native host has them; absent: links show as links. */
  readonly links?: Links;
  /** The notice that a new desktop version is out (ADR-0022). Only the desktop host has it; absent: no notice (the web client is always current). */
  readonly updates?: Updates;
  /** Other apps reading shared Private Spaces over MCP (ADR-0021). Only the desktop host has it; absent: no such setting. */
  readonly connectedApps?: ConnectedApps;
  /** The app's local log for problem reports (ADR-0040). Only the desktop host has it; absent: no log, nothing reported. */
  readonly diagnostics?: Diagnostics;
}

/** What the host does for problem reports (ADR-0040): it keeps a small redacted log on this computer and hands it over on request. */
export interface Diagnostics {
  /** An uncaught error of this window, for the host's log (it redacts, shortens and caps it). */
  report(e: { kind: "error" | "rejection"; message: string; stack?: string }): Promise<void>;
  /** The version, the system and the newest lines of the redacted log. */
  collect(): Promise<DiagnosticsBundle>;
  /** Whether the app keeps its local log; `setEnabled(false)` also deletes what it holds. */
  enabled(): Promise<boolean>;
  setEnabled(on: boolean): Promise<boolean>;
}

/** What the host does for the update notice (ADR-0022): it asks `latest.json` and keeps the person's choice. */
export interface Updates {
  /** Asks whether a newer version is out (once per start, then at most once in 24 hours; `force` skips the wait; nothing when the notice is off). */
  check(options?: { force?: boolean }): Promise<UpdateCheck>;
  settings(): Promise<UpdateSettings>;
  /** Turns the notice on or off. Off means no request at all. */
  setNotify(on: boolean): Promise<UpdateSettings>;
  /** "Skip this version": no notice for it or any older one. */
  skip(version: string): Promise<UpdateSettings>;
  /** "Download and install updates in the app" on or off (ADR-0034). */
  setInstall(on: boolean): Promise<UpdateSettings>;
  /** Update: the host downloads, checks the signature and installs (ADR-0034). */
  install(): Promise<InstallState>;
  cancel(): Promise<InstallState>;
  status(): Promise<InstallState>;
  /** After an update's restart: the Private Space to open again, once (null: none). */
  takeReopen(): Promise<string | null>;
  /** "Restart now", after this window wrote its edits; `reopen`: its Private Space, opened again after the restart. */
  restart(options?: { evenIfRunning?: boolean; reopen?: string }): Promise<RestartAnswer>;
  /** The host's `update.progress` events. */
  onProgress(listener: (state: InstallState) => void): Promise<() => void>;
}

/** Connected apps (ADR-0021): the user's settings, and the requests the host sends a window to answer. */
export interface ConnectedApps {
  settings(): Promise<ConnectedAppsSettings>;
  configure(change: { enabled?: boolean; spaces?: string[] }): Promise<ConnectedAppsSettings>;
  decide(app: string, allow: boolean): Promise<ConnectedAppsSettings>;
  forget(app: string): Promise<ConnectedAppsSettings>;
  log(): Promise<ConnectedAppsLogEntry[]>;
  answer(id: string, answer: McpAnswer): Promise<void>;
  /** A request for some window (each window answers only those whose `owner` is its own id). Returns the remover. */
  onRequest(listener: (request: McpRequest) => void): Promise<() => void>;
  /** The apps waiting for Allow or Deny changed. Returns the remover. */
  onPending(listener: (apps: string[]) => void): Promise<() => void>;
}

/** What the host does with web links (ADR-0020): it fetches their previews and opens them in the browser. */
export interface Links {
  preview(url: string): Promise<LinkPreview>;
  /** Forgets every cached preview. */
  clearPreviews(): Promise<void>;
  open(url: string): Promise<void>;
}

/** What a window asks of the app shell about windows (ADR-0019). Window ids are `space-` and lowercase letters or digits. */
export interface Windows {
  /**
   * Opens a new window `id` on the Private Space at `root` (a folder the user opened), showing `tabs` (a stored tab
   * list, `serializeTabs`), near the screen point `at` when given. Rejects when it could not be opened.
   */
  open(request: { id: string; root: string; tabs: string; at?: { x: number; y: number } }): Promise<void>;
  /**
   * Closes this window if another window of the app is open, and says whether it did (the last window stays). With
   * `evenIfLast` (the answer to `onCloseRequested`) it closes anyway; closing the last window quits the app.
   */
  closeThis(options?: { evenIfLast?: boolean }): Promise<boolean>;
  /** Another window was closed by the user (not by quitting the app); its id. Returns the remover. */
  onClosed(listener: (id: string) => void): Promise<() => void>;
  /**
   * The window's close button, or Quit, was used. The page writes its edits, then calls `closeThis({ evenIfLast: true })`;
   * a page that does not answer within a few seconds is closed anyway. Returns the remover.
   */
  onCloseRequested(listener: () => void): Promise<() => void>;
}

export interface Servers {
  list(): Promise<ServerInfo[]>;
  add(url: string): Promise<ServerInfo>;
  remove(server: string): Promise<void>;
  signIn(server: string, provider?: string): Promise<ServerInfo>;
  cancelSignIn(server: string): Promise<void>;
  useToken(server: string, token: string): Promise<ServerInfo>;
  signOut(server: string): Promise<ServerInfo>;
  /** One protocol request; `body` is sent as the request bytes. */
  call(args: ApiCallArgs, body?: Uint8Array): Promise<ApiCallResult>;
}
