/**
 * App-wide session handed to every feature. Owned by the shell (`src/app`);
 * features read it through `useSession()` and never construct ports themselves.
 */
import { createContext, useContext } from "react";
import type { Vault } from "@thoth/local-store";
import type { Platform, VaultConnection } from "@thoth/platform";
import type { ImportService } from "../features/import/service.ts";
import type { OpenImportSource } from "../features/import/open-source.ts";
import type { ServerDirectory, WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import type { TransferService } from "../features/transfer/service.ts";
import type { StarterServer } from "@thoth/app-ui/workspace/starter.ts";
import type { OpenOptions } from "@thoth/app-ui/tabs/model.ts";
import type { TabsController } from "@thoth/app-ui/tabs/useTabs.ts";

/** Tunables that tests (and later settings) override. */
export interface AppOptions {
  /** Idle time before an edited page is saved. 0 disables autosave. */
  autosaveMs: number;
  /** Quiet period that coalesces watcher events into one reconcile. */
  reconcileDebounceMs: number;
  /** Connects the import wizard to a source. Defaults to the marked function in `features/import/open-source.ts`. */
  openImportSource: OpenImportSource;
  now: () => Date;
  /** Change-feed polling interval for open workspaces (only while the window is visible). 0 disables polling. */
  pollMs: number;
  /** Suggested in Settings → Servers until added; null suggests nothing. */
  starterServer: StarterServer | null;
}

export interface Session {
  platform: Platform;
  connection: VaultConnection;
  vault: Vault;
  options: AppOptions;
  importService: ImportService;
  /** Bumped after any change to the index (save, reconcile, import) so views re-query. */
  revision: number;
  /** Call after mutating the vault outside the shell (e.g. an import) to refresh views. */
  refresh(): Promise<void>;
  /** Opens a page in the current tab, or in a new one (`newTab`: Cmd/Ctrl+click, middle-click, Cmd/Ctrl+Enter). */
  openPage(path: string, options?: OpenOptions): void;
  /** Opens Settings as a tab (one only), optionally scrolled to a section. */
  openSettings(section?: "servers"): void;
  /** The window's tabs (ADR-0016 rule 5). */
  tabs: TabsController;
  /** Workspace servers: the host holds the credentials; this is the app's view of them. */
  servers: ServerDirectory;
  /** Opens a page of a workspace on a server, in the current tab or a new one. */
  openWorkspacePage(ref: WorkspacePageRef, options?: OpenOptions): void;
  /** Copy and move between this Private Space and workspaces (ADR-0006). */
  transfers: TransferService;
  /** Expands a folder in the sidebar and opens its first page (e.g. "Open imported folder"). */
  openFolder(path: string): void;
  reveal: { path: string; nonce: number } | null;
  /** The open page registers how to write its pending edits; returns the unregister function. */
  registerFlush(flush: () => Promise<boolean>): () => void;
  /** Writes every pending edit. False when something (a conflict, an error) still needs the user. */
  flushAll(): Promise<boolean>;
  /** Closes this Private Space and returns to onboarding. */
  switchVault(): void;
  /** Set when the filesystem watcher could not start; saving still works. */
  watchError: string | null;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() outside an open vault");
  return session;
}
