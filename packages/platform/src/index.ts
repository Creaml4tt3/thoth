/**
 * What the app shell needs from the host it runs on (ADR-008). Desktop
 * implements it over Tauri; tests implement it over Node ports or the Rust
 * stdio harness. Domain logic (Vault, import pipeline) runs in TypeScript on
 * top of the ports a `Platform` hands out.
 */
import type { AgentHost } from "@thoth/agent-core";
import type { SourceHost } from "@thoth/importer-core";
import type { SqlDriver, VaultFs } from "@thoth/local-store";
import type { ApiCallArgs, ApiCallResult, ServerInfo, VaultChangedEvent } from "./ipc.ts";

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
  /** Shows this folder in Finder, File Explorer or Files. Absent where there is no file manager to open. */
  reveal?(): Promise<void>;
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
  /** Workspace servers. The host holds every credential; the webview only names a server by its handle. */
  readonly servers: Servers;
  /**
   * Agent CLIs on this computer (ADR-0007). Only a native host has them; absent means the Agent Hub is unavailable
   * (a browser can never spawn a process, spec 14.11).
   */
  readonly agents?: AgentHost;
  /** More windows of the app on a Private Space (ADR-0019). Only the desktop shell has them; absent: one window only. */
  readonly windows?: Windows;
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
