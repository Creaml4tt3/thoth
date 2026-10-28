/**
 * The app's view of workspace servers: which servers the host knows, their
 * workspaces, the page trees of expanded workspaces, and change-feed polling.
 *
 * It holds no credential. Every protocol request goes through
 * `servers.call`, where the host adds the server's token (the desktop's Rust
 * host, or the web client's in-memory session), so a `WorkspaceClient` here is
 * just typed requests over that call. A 401 that reaches the app means the host
 * could not refresh: the server is shown as signed out until the user signs in
 * again.
 */
import { newStableId } from "@thoth/domain";
import type { ServerInfo, Servers } from "@thoth/platform";
import { ProblemError, RevisionConflict, WorkspaceClient, type Send } from "@thoth/workspace-client";
import { PAGE_TITLE_MAX, type ChangeEntry, type DeletedWorkspace, type InviteAccepted, type PageMove, type PageResource, type TreeNode, type Workspace } from "@thoth/workspace-protocol";
import { placeAt } from "../order/fractional.ts";
import { folderMarkdown, isFolderMarkdown } from "./folders.ts";
import { childrenOf, isWithin } from "./tree.ts";
import { renameInMarkdown } from "./workspace-store.ts";

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
  /**
   * Which pages are folder pages (`thoth_kind: folder`), known as of the revision named. With the `page-kind`
   * capability (ADR-0017) it comes from the tree and the change feed. Without it the tree has no page kind, so it is
   * read from each page's Markdown once per revision.
   */
  kinds: Record<string, { revisionId: string; folder: boolean }>;
}

export interface DirectoryState {
  loaded: boolean;
  error: string | null;
  servers: ServerEntry[];
  /** Keyed by `workspaceKey(server, workspace)`. */
  trees: Record<string, TreeState>;
  /** Workspaces expanded in the sidebar (or holding the open page); only these are polled. */
  expanded: string[];
  /** Capability IDs each server lists (`/capabilities`), by server. Missing until the server answered. */
  capabilities: Record<string, string[]>;
  /** The limits each server advertises (`/capabilities` `limits`), by server. */
  limits: Record<string, Record<string, number>>;
  /** ADR-0025: the deleted workspaces the user can restore, by server (servers with `workspace-management`). */
  deleted: Record<string, DeletedWorkspace[]>;
}

export interface WorkspacePageRef {
  server: string;
  workspace: string;
  page: string;
}

export const workspaceKey = (server: string, workspace: string): string => `${server}\n${workspace}`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const EMPTY_TREE: TreeState = { nodes: [], cursor: null, loading: true, error: null, ticks: {}, kinds: {} };
/** The folder flags of a tree whose server lists `page-kind`: `kind` is the server's word, unknown counts as a page. */
function kindsOf(nodes: readonly TreeNode[]): TreeState["kinds"] {
  return Object.fromEntries(nodes.map((n) => [n.id, { revisionId: n.revisionId, folder: n.kind === "folder" }]));
}

/** How many pages are read at once to find out which are folders (servers without `page-kind`). */
const KIND_WORKERS = 4;

/** The bytes of a base64 body (an attachment, ADR-0028). */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class ServerDirectory {
  private state: DirectoryState = { loaded: false, error: null, servers: [], trees: {}, expanded: [], capabilities: {}, limits: {}, deleted: {} };
  private readonly kindWork = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly servers: Servers;
  private readonly pollMs: number;
  private readonly clients = new Map<string, WorkspaceClient>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private disposed = false;
  private readonly onVisibility = () => this.schedule(true);

  constructor(servers: Servers, options: { pollMs: number }) {
    this.servers = servers;
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

  /**
   * Does the server say which pages are folders (`page-kind`, ADR-0017)? Then folders are drawn from the `kind` of the
   * tree and the change feed, and no page is downloaded to find them. Without it each page is read once per revision.
   */
  hasPageKinds(server: string): boolean {
    return this.state.capabilities[server]?.includes("page-kind") ?? false;
  }

  /** Does the server keep page order and moves (`page-order`)? Without it pages are A–Z and cannot be reordered. */
  canOrder(server: string): boolean {
    return this.state.capabilities[server]?.includes("page-order") ?? false;
  }

  /** Does the server offer public read-only share links (`public-share`, ADR-0023)? */
  canShare(server: string): boolean {
    return this.state.capabilities[server]?.includes("public-share") ?? false;
  }

  /** Does the server list and manage members (`members`, ADR-0024)? */
  canManageMembers(server: string): boolean {
    return this.state.capabilities[server]?.includes("members") ?? false;
  }

  /** Does the server offer invite links (`invite-links`, ADR-0024)? */
  canInvite(server: string): boolean {
    return this.state.capabilities[server]?.includes("invite-links") ?? false;
  }

  /** Does the server let its users create, rename, delete and restore workspaces (`workspace-management`, ADR-0025)? */
  canManageWorkspaces(server: string): boolean {
    return this.state.capabilities[server]?.includes("workspace-management") ?? false;
  }

  /**
   * How many workspaces the user owns on the server and how many it allows (`maxWorkspacesPerAccount`, absent when
   * there is no limit). Deleted workspaces that can still be restored count, as the server counts them (ADR-0025).
   */
  ownership(server: string): { owned: number; deleted: number; limit: number | undefined } {
    const live = this.server(server)?.workspaces?.filter((w) => w.role === "owner").length ?? 0;
    const deleted = this.state.deleted[server]?.length ?? 0;
    return { owned: live + deleted, deleted, limit: this.state.limits[server]?.["maxWorkspacesPerAccount"] };
  }

  /**
   * Creates a workspace the user owns (ADR-0025), reads the list again and opens it in the sidebar. `idempotencyKey`
   * stays the same for retries of one attempt, so a lost response never makes two workspaces.
   */
  async createWorkspace(server: string, input: { name: string; exportRestricted: boolean }, idempotencyKey: string): Promise<Workspace> {
    const made = await this.client(server).createWorkspace(input, { idempotencyKey });
    const entry = this.server(server);
    if (entry?.workspaces && !entry.workspaces.some((w) => w.id === made.id)) this.patchServer(server, { workspaces: [...entry.workspaces, made] });
    this.expand(server, made.id);
    await this.loadWorkspaces(server);
    return made;
  }

  /** Owners only. The sidebar shows the new name at once. */
  async renameWorkspace(server: string, workspace: string, name: string): Promise<Workspace> {
    const renamed = await this.client(server).renameWorkspace(workspace, name);
    const entry = this.server(server);
    if (entry?.workspaces) this.patchServer(server, { workspaces: entry.workspaces.map((w) => (w.id === renamed.id ? renamed : w)) });
    return renamed;
  }

  /** Owners only. It leaves the sidebar at once and shows in Recently deleted. */
  async deleteWorkspace(server: string, workspace: string): Promise<void> {
    await this.client(server).deleteWorkspace(workspace);
    await this.forgetWorkspace(server, workspace);
  }

  /** Brings a deleted workspace back into the sidebar, opened. */
  async restoreWorkspace(server: string, workspace: string): Promise<Workspace> {
    const restored = await this.client(server).restoreWorkspace(workspace);
    this.set({ deleted: { ...this.state.deleted, [server]: (this.state.deleted[server] ?? []).filter((w) => w.id !== workspace) } });
    this.expand(server, restored.id);
    await this.loadWorkspaces(server);
    return restored;
  }

  /** Deletes a deleted workspace for good; it stops counting toward the user's workspaces. */
  async purgeWorkspace(server: string, workspace: string): Promise<void> {
    await this.client(server).purgeWorkspace(workspace);
    this.set({ deleted: { ...this.state.deleted, [server]: (this.state.deleted[server] ?? []).filter((w) => w.id !== workspace) } });
    await this.loadDeleted(server);
  }

  /** Reads the server's restorable deleted workspaces again (nothing when it lacks `workspace-management`). */
  async loadDeleted(server: string): Promise<void> {
    if (!this.canManageWorkspaces(server)) return;
    try {
      const deleted = await this.client(server).listDeletedWorkspaces();
      this.set({ deleted: { ...this.state.deleted, [server]: deleted } });
    } catch {
      // kept as it was; read again with the workspaces
    }
  }

  /** The known server at this origin (`ServerInfo.url` is the normalized origin). */
  serverAt(origin: string): ServerEntry | undefined {
    return this.state.servers.find((s) => s.info.url === origin);
  }

  /** What the server lists, loaded if not known yet (null when the server does not answer). */
  async capabilitiesOf(server: string): Promise<string[] | null> {
    await this.loadCapabilities(server);
    return this.state.capabilities[server] ?? null;
  }

  /**
   * A workspace the user is no longer in (they left, or an owner removed them, ADR-0024): it leaves the sidebar at
   * once, its tree stops polling, and the server's list is read again.
   */
  async forgetWorkspace(server: string, workspace: string): Promise<void> {
    const key = workspaceKey(server, workspace);
    const { [key]: _gone, ...trees } = this.state.trees;
    this.set({ trees, expanded: this.state.expanded.filter((k) => k !== key) });
    const entry = this.server(server);
    if (entry?.workspaces) this.patchServer(server, { workspaces: entry.workspaces.filter((w) => w.id !== workspace) });
    await this.loadWorkspaces(server);
  }

  /** Joins a workspace with an invite token, then reads the server's workspaces again so it shows in the sidebar. */
  async acceptInvite(server: string, token: string): Promise<InviteAccepted> {
    const accepted = await this.client(server).acceptInvite(token);
    await this.loadWorkspaces(server);
    return accepted;
  }

  // -------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    try {
      const list = await this.servers.list();
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
        const response = await this.servers.call(
          {
            server,
            method: req.method,
            path: req.path,
            ...(req.query ? { query: req.query } : {}),
            ...(req.headers ? { headers: req.headers } : {}),
            ...(req.binary ? { responseBytes: true } : {}),
          },
          req.body,
        );
        if (response.status === 401) this.markSignedOut(server);
        const { bodyBase64, ...rest } = response;
        return bodyBase64 === undefined ? rest : { ...rest, bytes: fromBase64(bodyBase64) };
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
      const [workspaces] = await Promise.all([this.client(server).listWorkspaces(), this.loadCapabilities(server)]);
      if (this.server(server)?.info.auth === "signed-out") return;
      this.patchServer(server, { workspaces, error: null });
      await this.loadDeleted(server);
    } catch (error) {
      if (error instanceof ProblemError && error.status === 401) return; // shown as signed out
      this.patchServer(server, { error: message(error) });
    }
  }

  /** What the server can do. A server that does not answer is treated as having no optional capability. */
  private async loadCapabilities(server: string): Promise<void> {
    if (this.state.capabilities[server]) return;
    try {
      const { capabilities, limits } = await this.client(server).getCapabilities();
      const numbers = Object.fromEntries(Object.entries(limits ?? {}).filter((e): e is [string, number] => typeof e[1] === "number"));
      this.set({ capabilities: { ...this.state.capabilities, [server]: [...capabilities] }, limits: { ...this.state.limits, [server]: numbers } });
    } catch {
      // retried the next time the workspaces load
    }
  }

  async add(url: string): Promise<ServerInfo> {
    const info = await this.servers.add(url);
    this.adopt(info);
    if (info.auth !== "signed-out") await this.loadWorkspaces(info.id);
    return info;
  }

  async remove(server: string): Promise<void> {
    await this.servers.remove(server);
    this.dropTrees(server);
    this.clients.delete(server);
    const { [server]: _gone, ...capabilities } = this.state.capabilities;
    const { [server]: _noLimits, ...limits } = this.state.limits;
    const { [server]: _noDeleted, ...deleted } = this.state.deleted;
    this.set({ servers: this.state.servers.filter((s) => s.info.id !== server), capabilities, limits, deleted });
  }

  private async signedIn(info: ServerInfo): Promise<ServerInfo> {
    this.adopt(info);
    this.patchServer(info.id, { error: null });
    await this.loadWorkspaces(info.id);
    return info;
  }

  async signIn(server: string, provider?: string): Promise<ServerInfo> {
    return this.signedIn(await this.servers.signIn(server, provider));
  }

  cancelSignIn(server: string): Promise<void> {
    return this.servers.cancelSignIn(server);
  }

  /** The token goes to the host once and is not kept here. */
  async useToken(server: string, token: string): Promise<ServerInfo> {
    return this.signedIn(await this.servers.useToken(server, token));
  }

  async signOut(server: string): Promise<ServerInfo> {
    const info = await this.servers.signOut(server);
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
      // The capability decides how folders are found, so it must be known before the tree is read.
      await this.loadCapabilities(server);
      const tree = await this.client(server).getTree(workspace);
      this.patchTree(key, { nodes: tree.nodes, cursor: tree.changeCursor, loading: false, error: null, ...(this.hasPageKinds(server) ? { kinds: kindsOf(tree.nodes) } : {}) });
      void this.resolveKinds(server, workspace);
    } catch (error) {
      this.patchTree(key, { loading: false, error: message(error) });
    }
  }

  /** Our own write: reflect it in the tree at once rather than waiting for the feed. */
  notePageSaved(server: string, page: PageResource): void {
    const key = workspaceKey(server, page.metadata.workspaceId);
    const tree = this.state.trees[key];
    if (!tree) return;
    const node: TreeNode = {
      id: page.id,
      parentId: page.metadata.parentId,
      title: page.metadata.title,
      ...(page.metadata.position !== undefined ? { position: page.metadata.position } : {}),
      ...(page.metadata.kind !== undefined ? { kind: page.metadata.kind } : {}),
      revisionId: page.revision.id,
      updatedAt: page.metadata.updatedAt,
    };
    const rest = tree.nodes.filter((n) => n.id !== page.id);
    // We hold the Markdown we just wrote, so a page of ours is known at once, with or without `page-kind`.
    const kinds = { ...tree.kinds, [page.id]: { revisionId: page.revision.id, folder: isFolderMarkdown(page.markdown) } };
    this.patchTree(key, { nodes: [...rest, node], kinds });
  }

  /** Makes an open page re-read itself (a rename wrote a new revision under it). */
  private bumpTick(key: string, id: string): void {
    const tree = this.state.trees[key];
    if (tree) this.patchTree(key, { ticks: { ...tree.ticks, [id]: (tree.ticks[id] ?? 0) + 1 } });
  }

  /**
   * New page: created with a fresh id and `If-None-Match: *`, so it can never overwrite a page. Shown in the
   * tree at once; the caller opens it. A full workspace answers `quota_exceeded`, thrown as `QuotaExceeded`.
   * `parentId` puts it inside another page.
   */
  async createPage(server: string, workspace: string, title: string, parentId?: string | null): Promise<PageResource> {
    const created = await this.client(server).createPage(workspace, { title, markdown: "", ...(parentId !== undefined ? { parentId } : {}) });
    if (!this.state.trees[workspaceKey(server, workspace)]) await this.loadTree(server, workspace);
    this.notePageSaved(server, created);
    return created;
  }

  /** New folder: a page marked `thoth_kind: folder` (ADR-0016 rule 3) that the tree draws as a folder. */
  async createFolder(server: string, workspace: string, title: string, parentId?: string | null): Promise<PageResource> {
    const id = newStableId();
    const created = await this.client(server).putPage(workspace, id, { title, markdown: folderMarkdown(id), ...(parentId !== undefined ? { parentId } : {}) }, null);
    if (!this.state.trees[workspaceKey(server, workspace)]) await this.loadTree(server, workspace);
    this.notePageSaved(server, created);
    return created;
  }

  /**
   * Renames a page from the tree. The title lives in the page's text when the text names one (frontmatter `title:`
   * or the first heading), so the text is changed with it; otherwise only the server's title changes. This writes a
   * new revision, on top of the one just read, so a page someone else changed meanwhile is a `RevisionConflict`.
   */
  async renamePage(server: string, workspace: string, pageId: string, title: string): Promise<PageResource> {
    const next = title.trim().slice(0, PAGE_TITLE_MAX);
    if (next === "") throw new Error("A title cannot be empty");
    const client = this.client(server);
    const page = await client.getPage(workspace, pageId);
    const written = await client.putPage(workspace, pageId, { title: next, markdown: renameInMarkdown(page.markdown, next) }, page.revision.id);
    this.notePageSaved(server, written);
    this.bumpTick(workspaceKey(server, workspace), pageId);
    return written;
  }

  private patchNode(key: string, node: TreeNode): void {
    const tree = this.state.trees[key];
    if (tree) this.patchTree(key, { nodes: tree.nodes.map((n) => (n.id === node.id ? { ...n, ...node } : n)) });
  }

  /**
   * Moves a page under `parentId` (null: the top level) at `index` among that parent's other children, in display
   * order. With `page-order` this is metadata only: just the moved page gets a new `position`, unless the keys
   * around it have no room left (or some siblings have none yet and would sort below it), in which case the
   * siblings are renumbered too. Without `page-order` there are no positions and no move route: the page can still
   * change parent, as a normal write of its own text, and `index` is ignored. Reordering within one parent throws.
   * A page changed by someone else meanwhile (412) is retried once on the fresh tree.
   */
  async movePage(server: string, workspace: string, pageId: string, target: { parentId: string | null; index: number }): Promise<void> {
    const key = workspaceKey(server, workspace);
    for (let attempt = 0; ; attempt++) {
      const tree = this.state.trees[key];
      const node = tree?.nodes.find((n) => n.id === pageId);
      if (!tree || !node) throw new Error("That page is not in the tree");
      if (target.parentId !== null && isWithin(tree.nodes, target.parentId, pageId)) throw new Error("A page cannot move into itself");
      const parentChanged = (node.parentId ?? null) !== target.parentId;
      try {
        if (!this.canOrder(server)) {
          if (!parentChanged) throw new Error("This server does not keep a page order");
          await this.reparent(server, workspace, pageId, target.parentId);
          return;
        }
        const siblings = childrenOf(tree.nodes, target.parentId).filter((n) => n.id !== pageId);
        const writes = placeAt(
          siblings.map((n) => ({ id: n.id, position: n.position ?? null })),
          pageId,
          target.index,
        );
        // The moved page goes last, so a failure part-way leaves it where it was.
        writes.sort((a, b) => Number(a.id === pageId) - Number(b.id === pageId));
        for (const write of writes) {
          const current = tree.nodes.find((n) => n.id === write.id)!;
          const move: PageMove = write.id === pageId && parentChanged ? { parentId: target.parentId, position: write.position } : { position: write.position };
          this.patchNode(key, await this.client(server).movePage(workspace, write.id, move, current.revisionId));
        }
        return;
      } catch (error) {
        if (!(error instanceof RevisionConflict) || attempt > 0) throw error;
        await this.loadTree(server, workspace); // someone changed a page: start again from what the server has
      }
    }
  }

  /**
   * Deletes a page and every page under it, deepest first, so a failure part-way never leaves a child at the top level
   * (the server deletes one page at a time and keeps the others). Each delete names the revision the tree has, so a
   * page someone changed meanwhile is a `RevisionConflict` and stays. Gone from the tree at once.
   */
  async deletePage(server: string, workspace: string, pageId: string): Promise<void> {
    const key = workspaceKey(server, workspace);
    const nodes = this.state.trees[key]?.nodes ?? [];
    if (!nodes.some((n) => n.id === pageId)) throw new Error("That page is not in the tree");
    const order = [pageId];
    for (let i = 0; i < order.length; i++) for (const n of nodes) if (n.parentId === order[i]) order.push(n.id);
    for (const id of order.reverse()) {
      const node = nodes.find((n) => n.id === id)!;
      try {
        await this.client(server).deletePage(workspace, id, node.revisionId);
      } catch (error) {
        if (!(error instanceof ProblemError && error.code === "not_found")) throw error; // already gone: nothing to do
      }
      const tree = this.state.trees[key];
      if (tree) this.patchTree(key, { nodes: tree.nodes.filter((n) => n.id !== id) });
    }
  }

  /** Changing the parent without `page-order`: a write of the page's own text with a new `parentId`. */
  private async reparent(server: string, workspace: string, pageId: string, parentId: string | null): Promise<void> {
    const client = this.client(server);
    const page = await client.getPage(workspace, pageId);
    const written = await client.putPage(workspace, pageId, { title: page.metadata.title, markdown: page.markdown, parentId }, page.revision.id);
    this.notePageSaved(server, written);
    this.bumpTick(workspaceKey(server, workspace), pageId);
  }

  /**
   * Fallback for servers without `page-kind`: finds out which pages of a workspace are folder pages. The tree has
   * only titles and parents, so each page is read once per revision, a few at a time; a page this client wrote is
   * already known. Failures are ignored: such a page is drawn as a page until the next change reaches it.
   */
  private async resolveKinds(server: string, workspace: string): Promise<void> {
    // `page-kind` (ADR-0017): the server already said which pages are folders. Reading pages for it is the fallback.
    if (this.hasPageKinds(server)) return;
    const key = workspaceKey(server, workspace);
    const tree = this.state.trees[key];
    if (!tree) return;
    const queue = tree.nodes.filter((n) => tree.kinds[n.id]?.revisionId !== n.revisionId && !this.kindWork.has(`${key}\n${n.id}`));
    if (queue.length === 0) return;
    for (const n of queue) this.kindWork.add(`${key}\n${n.id}`);
    let found: TreeState["kinds"] = {};
    const flush = () => {
      if (Object.keys(found).length === 0) return;
      const now = this.state.trees[key];
      if (now) this.patchTree(key, { kinds: { ...now.kinds, ...found } });
      found = {};
    };
    const worker = async () => {
      for (let n = queue.shift(); n; n = queue.shift()) {
        try {
          const page = await this.client(server).getPage(workspace, n.id);
          found[n.id] = { revisionId: page.revision.id, folder: isFolderMarkdown(page.markdown) };
          if (Object.keys(found).length >= 8) flush();
        } catch {
          // drawn as a page for now
        } finally {
          this.kindWork.delete(`${key}\n${n.id}`);
        }
        if (this.disposed) return;
      }
    };
    await Promise.all(Array.from({ length: KIND_WORKERS }, worker));
    flush();
  }

  private apply(server: string, tree: TreeState, entries: readonly ChangeEntry[]): Pick<TreeState, "nodes" | "ticks" | "kinds"> {
    const nodes = new Map(tree.nodes.map((n) => [n.id, n]));
    const ticks = { ...tree.ticks };
    // With `page-kind` the feed carries the kind after each change (`pageKind`); otherwise `resolveKinds` reads pages.
    const withKinds = this.hasPageKinds(server);
    const kinds = { ...tree.kinds };
    for (const entry of entries) {
      if (!entry.pageId) continue;
      if (entry.kind === "page.deleted") {
        nodes.delete(entry.pageId);
        if (withKinds) delete kinds[entry.pageId];
      } else if (entry.kind === "page.created" || entry.kind === "page.updated") {
        const old = nodes.get(entry.pageId);
        nodes.set(entry.pageId, {
          id: entry.pageId,
          parentId: entry.parentId !== undefined ? entry.parentId : (old?.parentId ?? null),
          title: entry.title ?? old?.title ?? "Untitled",
          ...(entry.position !== undefined ? { position: entry.position } : old?.position !== undefined ? { position: old.position } : {}),
          ...(entry.pageKind !== undefined ? { kind: entry.pageKind } : old?.kind !== undefined ? { kind: old.kind } : {}),
          revisionId: entry.revisionId ?? old?.revisionId ?? "",
          updatedAt: entry.occurredAt,
        });
        if (withKinds) {
          const kind = entry.pageKind !== undefined ? entry.pageKind : (old?.kind ?? null);
          kinds[entry.pageId] = { revisionId: entry.revisionId ?? old?.revisionId ?? "", folder: kind === "folder" };
        }
      } else continue; // unknown kinds are ignored
      ticks[entry.pageId] = (ticks[entry.pageId] ?? 0) + 1;
    }
    return { nodes: [...nodes.values()], ticks, kinds };
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
      // Not found: the user is no longer a member (ADR-0024). The list read again drops the workspace.
      else if (error instanceof ProblemError && error.status === 404) await this.loadWorkspaces(server);
      return; // a failed poll is retried at the next tick
    }
    const tree = this.state.trees[key];
    if (!tree || tree.cursor !== start.cursor) return; // reloaded meanwhile
    this.patchTree(key, { ...(entries.length > 0 ? this.apply(server, tree, entries) : {}), cursor });
    if (entries.length > 0) void this.resolveKinds(server, workspace);
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
