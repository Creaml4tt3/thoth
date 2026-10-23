/**
 * The app's view of workspace servers: which servers the host knows, their
 * workspaces, the page trees of expanded workspaces, and change-feed polling.
 *
 * It holds no credential. Every protocol request goes through
 * `platform.servers.call`, where the host adds the server's token, so a
 * `WorkspaceClient` here is just typed requests over that call. A 401 that
 * reaches the app means the host could not refresh: the server is shown as
 * signed out until the user signs in again.
 */
import type { Platform, ServerInfo } from "@thoth/platform";
import { ProblemError, WorkspaceClient, type Send } from "@thoth/workspace-client";
import type { ChangeEntry, PageResource, TreeNode, Workspace } from "@thoth/workspace-protocol";

export interface ServerEntry {
  info: ServerInfo;
  /** Null while signed out or not yet loaded. */
  workspaces: Workspace[] | null;
  /** Why the workspace list could not be loaded. */
  error: string | null;
}

export interface TreeState {
  nodes: TreeNode[];
  /** Change-feed position; null until the tree has loaded. */
  cursor: string | null;
  loading: boolean;
  error: string | null;
  /** Bumped per page whenever the change feed reports it, so an open page re-checks itself. */
  ticks: Record<string, number>;
}

export interface DirectoryState {
  loaded: boolean;
  error: string | null;
  servers: ServerEntry[];
  /** Keyed by `workspaceKey(server, workspace)`. */
  trees: Record<string, TreeState>;
  /** Workspaces expanded in the sidebar (or holding the open page); only these are polled. */
  expanded: string[];
}

export interface WorkspacePageRef {
  server: string;
  workspace: string;
  page: string;
}

export const workspaceKey = (server: string, workspace: string): string => `${server}\n${workspace}`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const EMPTY_TREE: TreeState = { nodes: [], cursor: null, loading: true, error: null, ticks: {} };

export class ServerDirectory {
  private state: DirectoryState = { loaded: false, error: null, servers: [], trees: {}, expanded: [] };
  private readonly listeners = new Set<() => void>();
  private readonly platform: Platform;
  private readonly pollMs: number;
  private readonly clients = new Map<string, WorkspaceClient>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private disposed = false;
  private readonly onVisibility = () => this.schedule(true);

  constructor(platform: Platform, options: { pollMs: number }) {
    this.platform = platform;
    this.pollMs = options.pollMs;
  }

  // ------------------------------------------------------------------ store

  getState = (): DirectoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<DirectoryState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private patchServer(id: string, patch: Partial<ServerEntry>): void {
    this.set({ servers: this.state.servers.map((s) => (s.info.id === id ? { ...s, ...patch } : s)) });
  }

  private patchTree(key: string, patch: Partial<TreeState>): void {
    this.set({ trees: { ...this.state.trees, [key]: { ...(this.state.trees[key] ?? EMPTY_TREE), ...patch } } });
  }

  server(id: string): ServerEntry | undefined {
    return this.state.servers.find((s) => s.info.id === id);
  }

  workspace(server: string, workspace: string): Workspace | undefined {
    return this.server(server)?.workspaces?.find((w) => w.id === workspace);
  }

  // -------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    try {
      const list = await this.platform.servers.list();
      this.set({ loaded: true, error: null, servers: list.map((info) => ({ info, workspaces: null, error: null })) });
      await Promise.all(list.filter((s) => s.auth !== "signed-out").map((s) => this.loadWorkspaces(s.id)));
    } catch (error) {
      this.set({ loaded: true, error: message(error) });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- servers

  /** A typed protocol client for one server. Requests go through the host, which adds the credential. */
  client(server: string): WorkspaceClient {
    let client = this.clients.get(server);
    if (!client) {
      const send: Send = async (req) => {
        const response = await this.platform.servers.call(
          { server, method: req.method, path: req.path, ...(req.query ? { query: req.query } : {}), ...(req.headers ? { headers: req.headers } : {}) },
          req.body,
        );
        if (response.status === 401) this.markSignedOut(server);
        return response;
      };
      client = new WorkspaceClient(send);
      this.clients.set(server, client);
    }
    return client;
  }

  /** The host already tried to refresh: show the server as signed out and stop polling it. */
  private markSignedOut(server: string): void {
    const entry = this.server(server);
    if (!entry || entry.info.auth === "signed-out") return;
    const { account: _account, ...info } = entry.info;
    this.patchServer(server, { info: { ...info, auth: "signed-out" }, workspaces: null, error: null });
    this.dropTrees(server);
  }

  private dropTrees(server: string): void {
    const prefix = `${server}\n`;
    this.set({
      expanded: this.state.expanded.filter((k) => !k.startsWith(prefix)),
      trees: Object.fromEntries(Object.entries(this.state.trees).filter(([k]) => !k.startsWith(prefix))),
    });
  }

  private adopt(info: ServerInfo): void {
    const exists = this.server(info.id);
    if (exists) this.patchServer(info.id, { info, ...(info.auth === "signed-out" ? { workspaces: null } : {}) });
    else this.set({ servers: [...this.state.servers, { info, workspaces: null, error: null }] });
  }

  async loadWorkspaces(server: string): Promise<void> {
    try {
      const workspaces = await this.client(server).listWorkspaces();
      if (this.server(server)?.info.auth === "signed-out") return;
      this.patchServer(server, { workspaces, error: null });
    } catch (error) {
      if (error instanceof ProblemError && error.status === 401) return; // shown as signed out
      this.patchServer(server, { error: message(error) });
    }
  }

  async add(url: string): Promise<ServerInfo> {
    const info = await this.platform.servers.add(url);
    this.adopt(info);
    if (info.auth !== "signed-out") await this.loadWorkspaces(info.id);
    return info;
  }

  async remove(server: string): Promise<void> {
    await this.platform.servers.remove(server);
    this.dropTrees(server);
    this.clients.delete(server);
    this.set({ servers: this.state.servers.filter((s) => s.info.id !== server) });
  }

  private async signedIn(info: ServerInfo): Promise<ServerInfo> {
    this.adopt(info);
    this.patchServer(info.id, { error: null });
    await this.loadWorkspaces(info.id);
    return info;
  }

  async signIn(server: string, provider?: string): Promise<ServerInfo> {
    return this.signedIn(await this.platform.servers.signIn(server, provider));
  }

  cancelSignIn(server: string): Promise<void> {
    return this.platform.servers.cancelSignIn(server);
  }

  /** The token goes to the host once and is not kept here. */
  async useToken(server: string, token: string): Promise<ServerInfo> {
    return this.signedIn(await this.platform.servers.useToken(server, token));
  }

  async signOut(server: string): Promise<ServerInfo> {
    const info = await this.platform.servers.signOut(server);
    this.dropTrees(server);
    this.adopt(info);
    return info;
  }

  // ------------------------------------------------------------------ trees

  /** Expands a workspace: loads its tree and polls its change feed while the window is visible. */
  expand(server: string, workspace: string): void {
    const key = workspaceKey(server, workspace);
    if (!this.state.expanded.includes(key)) this.set({ expanded: [...this.state.expanded, key] });
    if (!this.state.trees[key]) void this.loadTree(server, workspace);
    this.schedule(false);
  }

  collapse(server: string, workspace: string): void {
    const key = workspaceKey(server, workspace);
    this.set({ expanded: this.state.expanded.filter((k) => k !== key) });
  }

  async loadTree(server: string, workspace: string): Promise<void> {
    const key = workspaceKey(server, workspace);
    this.patchTree(key, { loading: true, error: null });
    try {
      const tree = await this.client(server).getTree(workspace);
      this.patchTree(key, { nodes: tree.nodes, cursor: tree.changeCursor, loading: false, error: null });
    } catch (error) {
      this.patchTree(key, { loading: false, error: message(error) });
    }
  }

  /** Our own write: reflect it in the tree at once rather than waiting for the feed. */
  notePageSaved(server: string, page: PageResource): void {
    const key = workspaceKey(server, page.metadata.workspaceId);
    const tree = this.state.trees[key];
    if (!tree) return;
    const node: TreeNode = { id: page.id, parentId: page.metadata.parentId, title: page.metadata.title, revisionId: page.revision.id, updatedAt: page.metadata.updatedAt };
    const rest = tree.nodes.filter((n) => n.id !== page.id);
    this.patchTree(key, { nodes: [...rest, node] });
  }

  private apply(tree: TreeState, entries: readonly ChangeEntry[]): Pick<TreeState, "nodes" | "ticks"> {
    const nodes = new Map(tree.nodes.map((n) => [n.id, n]));
    const ticks = { ...tree.ticks };
    for (const entry of entries) {
      if (!entry.pageId) continue;
      if (entry.kind === "page.deleted") nodes.delete(entry.pageId);
      else if (entry.kind === "page.created" || entry.kind === "page.updated") {
        const old = nodes.get(entry.pageId);
        nodes.set(entry.pageId, {
          id: entry.pageId,
          parentId: entry.parentId !== undefined ? entry.parentId : (old?.parentId ?? null),
          title: entry.title ?? old?.title ?? "Untitled",
          revisionId: entry.revisionId ?? old?.revisionId ?? "",
          updatedAt: entry.occurredAt,
        });
      } else continue; // unknown kinds are ignored
      ticks[entry.pageId] = (ticks[entry.pageId] ?? 0) + 1;
    }
    return { nodes: [...nodes.values()], ticks };
  }

  /** Reads the change feed of one workspace up to its head and applies it to the tree. */
  async pollWorkspace(server: string, workspace: string): Promise<void> {
    const key = workspaceKey(server, workspace);
    const start = this.state.trees[key];
    if (!start || start.cursor === null || start.loading) return;
    let cursor = start.cursor;
    const entries: ChangeEntry[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const page = await this.client(server).listChanges(workspace, cursor);
        entries.push(...page.entries);
        cursor = page.cursor;
        if (!page.hasMore) break;
      }
    } catch (error) {
      if (error instanceof ProblemError && error.code === "cursor_expired") await this.loadTree(server, workspace);
      return; // a failed poll is retried at the next tick
    }
    const tree = this.state.trees[key];
    if (!tree || tree.cursor !== start.cursor) return; // reloaded meanwhile
    this.patchTree(key, { ...(entries.length > 0 ? this.apply(tree, entries) : {}), cursor });
  }

  async pollNow(): Promise<void> {
    await Promise.all(
      this.state.expanded.map((key) => {
        const [server, workspace] = key.split("\n") as [string, string];
        return this.pollWorkspace(server, workspace);
      }),
    );
  }

  private visible(): boolean {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  /** Keeps one timer running while something is expanded and the window is visible. */
  private schedule(immediately: boolean): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.visible() || this.state.expanded.length === 0 || this.pollMs <= 0) return;
    this.timer = setTimeout(() => void this.tick(), immediately ? 0 : this.pollMs);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.polling || !this.visible()) return this.schedule(false);
    this.polling = true;
    try {
      await this.pollNow();
    } finally {
      this.polling = false;
      this.schedule(false);
    }
  }
}
