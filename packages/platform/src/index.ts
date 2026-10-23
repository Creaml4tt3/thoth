/**
 * What the app shell needs from the host it runs on (ADR-008). Desktop
 * implements it over Tauri; tests implement it over Node ports or the Rust
 * stdio harness. Domain logic (Vault, import pipeline) runs in TypeScript on
 * top of the ports a `Platform` hands out.
 */
import type { SourceHost } from "@thoth/importer-core";
import type { SqlDriver, VaultFs } from "@thoth/local-store";
import type { ApiCallArgs, ApiCallResult, ServerInfo, VaultChangedEvent } from "./ipc.ts";

export type * from "./ipc.ts";

export interface VaultConnection {
  readonly root: string;
  readonly label: string;
  readonly fs: VaultFs;
  readonly sql: SqlDriver;
  /** Starts the filesystem watcher. It is a trigger only: listeners should debounce into `vault.reconcile()`. */
  watch(listener: (event: Omit<VaultChangedEvent, "vault">) => void): Promise<() => Promise<void>>;
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
