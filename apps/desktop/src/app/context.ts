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
import type { AgentsService } from "../features/agents/service.ts";
import type { AssistantController } from "../features/mascot/controller.ts";
import type { StarterServer } from "@thoth/app-ui/workspace/starter.ts";
import type { OpenOptions } from "@thoth/app-ui/tabs/model.ts";
import type { TabsController } from "@thoth/app-ui/tabs/useTabs.ts";
import type { NotificationCenter, NotificationTarget, SystemNotifier } from "@thoth/app-ui/notifications/core.ts";
import type { NotificationPrefsStore } from "../features/notifications/prefs.ts";
import type { UpdateService } from "../features/updates/service.ts";
import type { RecentStore } from "@thoth/app-ui/home/recent.ts";

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
  /** Shows system notifications (ADR-0018): the notification plugin in the desktop app, nothing elsewhere. */
  notifier: SystemNotifier;
  /** How long the mascot's message after a run stays up. */
  messageMs: number;
  /** The update notice (ADR-0022): time from the start to its first check, and between checks after that. */
  updateDelayMs: number;
  updateIntervalMs: number;
  /**
   * What a window shows when nothing was open (ADR-0029): Home, or (false) the first page by path, as before Home.
   * The unit tests start on the first page unless they test Home.
   */
  startOnHome: boolean;
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
  openSettings(section?: "servers" | "agents" | "import"): void;
  /** The window's tabs (ADR-0016 rule 5). */
  tabs: TabsController;
  /** Workspace servers: the host holds the credentials; this is the app's view of them. */
  servers: ServerDirectory;
  /** Opens a page of a workspace on a server, in the current tab or a new one. */
  openWorkspacePage(ref: WorkspacePageRef, options?: OpenOptions): void;
  /** Copy and move between this Private Space and workspaces (ADR-0006). */
  transfers: TransferService;
  /** The agent runs (ADR-0007); null where the host cannot run agent CLIs. */
  agents: AgentsService | null;
  /** The mascot and its prompt bubble; null where there are no agents. */
  assistant: AssistantController | null;
  /** Opens the mascot's prompt bubble; `selection` (vault paths) becomes the next task's context. */
  askAssistant(selection?: string[]): void;
  /** Opens the session tab of the current run (its transcript, answer, review and result); nothing without a run. */
  openAgentReview(): void;
  /** Opens the session tab of run `id`: its conversation's tab (one tab per conversation: an open one is brought forward). */
  openAgentRun(id: string): void;
  /**
   * True while this window is the only one on its Private Space (ADR-0019 rule 5). A run waiting for review that this
   * window does not run may then be reopened here; with other windows open it may be theirs, so it is shown read-only.
   */
  alone: boolean;
  /**
   * Expands a folder in the sidebar and opens its first page (e.g. "Open imported folder"); with `openFirstPage: false`
   * it only expands it (a breadcrumb: the open page stays). With `keepCurrent` (a notification) the first page goes to
   * its tab, or opens in a new one, instead of replacing the current tab's page.
   */
  openFolder(path: string, options?: { openFirstPage?: boolean; keepCurrent?: boolean }): void;
  reveal: { path: string; nonce: number } | null;
  /** The open page registers how to write its pending edits; returns the unregister function. */
  registerFlush(flush: () => Promise<boolean>): () => void;
  /** Writes every pending edit. False when something (a conflict, an error) still needs the user. */
  flushAll(): Promise<boolean>;
  /** The pages opened last in this Private Space (ADR-0029), for Home. */
  recent: RecentStore;
  /** The notification list of this window (ADR-0018), and the user's settings for system notifications. */
  notifications: NotificationCenter;
  notificationPrefs: NotificationPrefsStore;
  /** Opens what a notification is about: a run's review or outcome, a page, a folder. */
  openNotification(target: NotificationTarget): void;
  /** The notice that a new desktop version is out (ADR-0022); null where the host has none. */
  updates: UpdateService | null;
  /** Closes this Private Space and returns to onboarding. */
  switchVault(): void;
  /** Set when the filesystem watcher could not start; saving still works. */
  watchError: string | null;
  /** Which window this is (ADR-0019): "main", or the id of a window the app opened (`platform.windows`). */
  windowId: string;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() outside an open vault");
  return session;
}
