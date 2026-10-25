/**
 * Command contract between the TypeScript ports and the native host (ADR-008).
 *
 * One dispatch table is implemented in Rust (`crates/thoth-host`) and exposed
 * through Tauri commands (desktop) and a stdio harness (port contract tests and
 * the e2e dev bridge). TypeScript reaches it only through a `Transport`, so the
 * same `Remote*` port adapters run over every transport.
 *
 * Bytes travel out of band (a raw IPC body, or base64 on stdio), never as JSON
 * arrays of numbers. The webview is untrusted: the host only opens vault roots
 * and import sources that the user picked in a native dialog (or reopened from
 * the host's own recent list), and every path argument is vault- or
 * source-relative.
 */
import type { DirEntry, FileStat } from "@thoth/local-store";
import type { SourceDirEntry } from "@thoth/importer-core";
import type { AgentProbe, HostEventBatch, HostHistoryRun } from "@thoth/agent-core";

/** SQL values on the wire. Integers outside ±2^53 and blobs are tagged. */
export type WireValue = null | string | number | { $bigint: string } | { $bytes: string };
export type WireRow = Record<string, WireValue>;

/**
 * Error codes a host returns as `{ code, message }`. File-system codes match
 * POSIX errno names because `@thoth/local-store` checks `error.code`.
 */
export type HostErrorCode =
  | "EEXIST"
  | "CONFLICT"
  | "ENOENT"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOTEMPTY"
  | "EACCES"
  | "EIO"
  | "UNSAFE_PATH"
  | "NOT_ALLOWED"
  | "NOT_A_REGULAR_FILE"
  | "BAD_HANDLE"
  | "BAD_ARGUMENT"
  | "SQLITE_ERROR"
  | "SQLITE_BUSY"
  | "SQLITE_CONSTRAINT"
  /** A server could not be reached, or answered something that is not a Thoth server. */
  | "SERVER_UNREACHABLE"
  /** Browser sign-in did not complete (refused, mismatch, timeout, cancelled). The message says which, in plain words. */
  | "SIGN_IN_FAILED"
  /** The agent CLI could not be found or started. */
  | "AGENT_UNAVAILABLE"
  /** A link preview could not be fetched: the page did not answer, took too long, or is not HTML (ADR-0020). */
  | "PREVIEW_UNAVAILABLE"
  | "INTERNAL";

export interface HostError {
  code: HostErrorCode;
  message: string;
}

export interface VaultChangedEvent {
  vault: string;
  /** Vault-relative paths that changed; may be empty when `rescan` is set. */
  paths: string[];
  /** The watcher lost events (overflow, root moved); the client must run a full reconcile. */
  rescan: boolean;
}

type Bytes = Uint8Array;

export interface Commands {
  "vault.pick": { args: Record<string, never>; result: string | null };
  "vault.recent": { args: Record<string, never>; result: string[] };
  /** `shared`: another handle (another window) already has this folder open (ADR-0019); that window ran recovery. */
  "vault.open": { args: { root: string }; result: { vault: string; root: string; label: string; shared: boolean } };
  "vault.close": { args: { vault: string }; result: null };
  /** Shows the open vault's folder in the system file manager. By handle only: the webview cannot name a path. */
  "vault.reveal": { args: { vault: string }; result: null };
  /** True while another handle (another window) has this vault's folder open (ADR-0019). */
  "vault.shared": { args: { vault: string }; result: boolean };

  "fs.stat": { args: { vault: string; path: string }; result: FileStat | null };
  "fs.read": { args: { vault: string; path: string }; result: Bytes };
  "fs.list": { args: { vault: string; dir: string }; result: DirEntry[] };
  "fs.mkdirp": { args: { vault: string; dir: string }; result: null };
  /** Request bytes: the file content. */
  "fs.write": { args: { vault: string; path: string; exclusive: boolean }; result: null };
  /** With `replaceHash`, `to` is replaced only while it still has that SHA-256 (else `CONFLICT`), checked and renamed as one step. */
  "fs.rename": { args: { vault: string; from: string; to: string; noReplace: boolean; replaceHash?: string }; result: null };
  "fs.remove": { args: { vault: string; path: string }; result: null };

  "sql.exec": { args: { vault: string; sql: string }; result: null };
  "sql.run": { args: { vault: string; sql: string; params: WireValue[] }; result: { changes: number } };
  "sql.all": { args: { vault: string; sql: string; params: WireValue[] }; result: WireRow[] };
  "sql.get": { args: { vault: string; sql: string; params: WireValue[] }; result: WireRow | null };

  /** Emits `vault.changed` events until stopped or the vault is closed. */
  "watch.start": { args: { vault: string }; result: null };
  "watch.stop": { args: { vault: string }; result: null };

  "source.pick": { args: { kind: "file" | "directory" }; result: string | null };
  "source.open": { args: { location: string }; result: { source: string; rootKind: "file" | "directory"; label: string; location: string } };
  "source.list": { args: { source: string; dir: string }; result: SourceDirEntry[] };
  "source.file.open": { args: { source: string; path: string }; result: { file: string; size: number } };
  "source.file.read": { args: { file: string; position: number; length: number }; result: Bytes };
  "source.file.close": { args: { file: string }; result: null };
  "source.temp.create": { args: { source: string }; result: { file: string } };
  /** Request bytes: the data to write at `position`. */
  "source.temp.write": { args: { file: string; position: number }; result: null };
  "source.close": { args: { source: string }; result: null };

  // ---- Workspace servers (Phase 2b part 3). The host is the HTTP client: tokens never enter the webview.
  "server.list": { args: Record<string, never>; result: ServerInfo[] };
  /** Fetches `/api/v1/capabilities` from `url` and remembers the server. `https`, or `http` on a loopback host only. */
  "server.add": { args: { url: string }; result: ServerInfo };
  /** Signs out (best effort), deletes the stored secrets and forgets the server. */
  "server.remove": { args: { server: string }; result: null };
  /**
   * Browser sign-in (RFC 8252 loopback + PKCE) against the server's advertised `signIn` endpoints. Resolves when the
   * browser comes back, or rejects with `SIGN_IN_FAILED` (refused, wrong state/iss, timeout after 5 minutes, cancelled).
   */
  "server.signIn": { args: { server: string; provider?: string }; result: ServerInfo };
  "server.signInCancel": { args: { server: string }; result: null };
  /** Stores a personal access token after checking it with `GET /api/v1/me`. The token is not echoed back. */
  "server.useToken": { args: { server: string; token: string }; result: ServerInfo };
  /** Revokes the session on the server (best effort) and deletes the stored secrets. The server stays listed. */
  "server.signOut": { args: { server: string }; result: ServerInfo };
  /**
   * One protocol request, sent by the host with the server's credential. `path` must start with `/api/v1/`.
   * Request bytes: the body (with `contentType`). After a 401 the host refreshes once and retries; if that fails
   * the server becomes `signed-out` and the 401 is returned.
   */
  "api.call": { args: ApiCallArgs; result: ApiCallResult };

  // ---- Agent Hub (ADR-0007). Desktop only: there is no web equivalent (spec 3.3, 14.11).
  /** Finds the provider's CLI (PATH and the usual install folders) and runs its fixed probes. */
  "agent.detect": { args: { provider: string }; result: AgentProbe };
  /** A new, empty, private working directory under the app data folder. `dir` is for display only. */
  "agent.run.create": { args: { provider: string }; result: { run: string; dir: string } };
  "agent.fs.stat": { args: { run: string; path: string }; result: FileStat | null };
  "agent.fs.read": { args: { run: string; path: string }; result: Bytes };
  "agent.fs.list": { args: { run: string; dir: string }; result: DirEntry[] };
  /** Only before `agent.start`. */
  "agent.fs.mkdirp": { args: { run: string; dir: string }; result: null };
  /**
   * Request bytes: the file. Exclusive create, only before `agent.start`. `readOnly` takes the write permission away
   * afterwards (reference copies of workspace pages, ADR-0007).
   */
  "agent.fs.write": { args: { run: string; path: string; readOnly?: boolean }; result: null };
  /**
   * Request bytes: the CLI's stdin (the prompt). The host runs the provider's binary with `argv` only when its policy
   * accepts every argument (`NOT_ALLOWED` otherwise), in the working directory, in its own process group.
   */
  "agent.start": { args: { run: string; argv: string[]; timeoutMs?: number }; result: null };
  /** Output events after `after`; waits up to `waitMs` (at most 10 s) for the first. */
  "agent.events": { args: { run: string; after: number; waitMs: number }; result: HostEventBatch };
  "agent.cancel": { args: { run: string }; result: null };
  /** Stops the run if needed and deletes its working directory. */
  "agent.run.dispose": { args: { run: string }; result: null };
  /** Deletes working directories left by an earlier session. */
  "agent.sweep": { args: Record<string, never>; result: { removed: number } };
  /**
   * Local-only run details (transcript, proposed files) under the app data folder, never in a vault (ADR-0007,
   * "History"). `id` is a run record's UUID and `name` a short flat file name; the host accepts nothing else. Request
   * bytes: the file (replaced atomically).
   */
  "agent.history.write": { args: { id: string; name: string }; result: null };
  "agent.history.read": { args: { id: string; name: string }; result: Bytes };
  /** Every run that has details, oldest first, with when its files last changed. */
  "agent.history.list": { args: Record<string, never>; result: HostHistoryRun[] };
  /** Deletes one run's details. Repeating it is harmless. */
  "agent.history.delete": { args: { id: string }; result: null };

  // ---- Link previews (ADR-0020). Desktop only: the host fetches, the webview has no network.
  /**
   * The Open Graph preview of an `http(s)` link, from the host's cache (app data folder) when fresh. The host connects
   * to public addresses only (checked after DNS, for every hop), follows at most 5 redirects, gives up after 5 s and
   * reads at most 512 KB of HTML. `NOT_ALLOWED`: a scheme, credentials or an address it refuses;
   * `PREVIEW_UNAVAILABLE`: no answer, not HTML, too slow. Every text field is plain text, never HTML.
   */
  "link.preview": { args: { url: string }; result: LinkPreview };
  /** Forgets every cached preview and failure. */
  "link.preview.clear": { args: Record<string, never>; result: null };
  /** Opens an `http(s)` link in the system browser (the webview has no opener). */
  "link.open": { args: { url: string }; result: null };
}

/** What a page says about itself (ADR-0020). Text is decoded, stripped of control characters and cut. */
export interface LinkPreview {
  /** The link asked for (normalized, without its `#fragment`). */
  url: string;
  /** Where the last redirect ended. */
  finalUrl: string;
  /** `og:site_name`, at most 80 characters. */
  siteName?: string;
  /** `og:title`, `twitter:title` or `<title>`, at most 200 characters. */
  title?: string;
  /** `og:description` or `twitter:description`, at most 300 characters. */
  description?: string;
  /** `og:image` or `twitter:image` as a `data:` URL: PNG, JPEG, GIF or WebP (by its bytes), at most 2 MB. */
  image?: string;
}

export interface ServerInfo {
  /** Opaque handle chosen by the host. */
  id: string;
  /** Normalized origin, e.g. `https://api.thoth.creaml4tt3.me` or `http://127.0.0.1:8080`. */
  url: string;
  /** `capabilities.server.name` without control characters, trimmed, at most 64 characters; else the host name (no port). */
  label: string;
  auth: "signed-out" | "browser" | "token";
  /** `GET /me` at sign-in; absent when signed out. */
  account?: { id: string; displayName: string; email?: string };
  /** Providers from `capabilities.signIn`; empty when the server offers only tokens. */
  providers: { id: string; name: string }[];
  /** Limits advertised by the server (the trial shows them); absent when none. */
  limits?: Record<string, number>;
}

export interface ApiCallArgs {
  server: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** `/api/v1/...`, no query string; `..`, `//`, `#` and `?` are refused. */
  path: string;
  query?: Record<string, string>;
  /** Only `if-match`, `if-none-match`, `idempotency-key` and `content-type` are forwarded. */
  headers?: Record<string, string>;
}

export interface ApiCallResult {
  status: number;
  /** Only `content-type`, `etag`, `location` and `retry-after`. */
  headers: Record<string, string>;
  /** The response body as UTF-8 text (JSON or problem JSON). At most 32 MiB. */
  body: string;
}

export type CommandName = keyof Commands;

export interface Transport {
  call<C extends CommandName>(command: C, args: Commands[C]["args"], bytes?: Uint8Array): Promise<Commands[C]["result"]>;
  listen(event: "vault.changed", handler: (payload: VaultChangedEvent) => void): Promise<() => void>;
}
