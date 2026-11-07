/**
 * A fake of the host's Connected apps (ADR-0021, ADR-0048) for the desktop tests: the settings, the questions, the
 * requests a window answers, and the proposals the host keeps.
 */
import type {
  ConnectedAppProposal,
  ConnectedAppProposalText,
  ConnectedApps,
  ConnectedAppsLogEntry,
  ConnectedAppsSettings,
  McpAnswer,
  McpRequest,
  MemoryHistoryText,
  MemoryWritten,
  SkillLinksReport,
} from "@thoth/platform";

export const SIDECAR = "/Applications/Thoth.app/Contents/MacOS/thoth-mcp";
export const SOCKET = "/Users/someone/Library/Application Support/com.thothnotes.desktop/mcp/thoth.sock";

export class FakeConnectedApps implements ConnectedApps {
  state: ConnectedAppsSettings = { available: true, enabled: false, listening: false, error: null, spaces: [], apps: [], pending: [], proposers: [], memories: true, memoryFolders: {}, folders: [], setup: { command: SIDECAR, args: ["--socket", SOCKET] } };
  calls: unknown[][] = [];
  answers: { id: string; answer: McpAnswer }[] = [];
  entries: ConnectedAppsLogEntry[] = [];
  /** The proposals kept, with their text. */
  kept: ConnectedAppProposalText[] = [];
  /** The memory writes without review, newest first, with their text. */
  history: MemoryHistoryText[] = [];
  private readonly requests = new Set<(r: McpRequest) => void>();
  private readonly pendings = new Set<(apps: string[]) => void>();
  private readonly proposalListeners = new Set<(open: number) => void>();
  private readonly memoryListeners = new Set<(written: MemoryWritten) => void>();

  private copy = () => structuredClone(this.state);
  async settings() {
    return this.copy();
  }
  async configure(change: { enabled?: boolean; spaces?: string[]; memories?: boolean }) {
    this.calls.push(["configure", change]);
    if (change.memories !== undefined) this.state.memories = change.memories;
    if (change.enabled !== undefined) Object.assign(this.state, { enabled: change.enabled, listening: change.enabled });
    if (change.spaces) this.state.spaces = change.spaces;
    return this.copy();
  }
  async decide(app: string, allow: boolean) {
    this.calls.push(["decide", app, allow]);
    const known = this.state.apps.find((a) => a.name === app);
    this.state.apps = [...this.state.apps.filter((a) => a.name !== app), { name: app, allowed: allow, decidedAt: "2026-10-26T09:00:00Z", propose: known?.propose ?? null }];
    this.state.pending = this.state.pending.filter((p) => p !== app);
    this.emitPending();
    return this.copy();
  }
  async forget(app: string) {
    this.calls.push(["forget", app]);
    this.state.apps = this.state.apps.filter((a) => a.name !== app);
    return this.copy();
  }
  async log() {
    return this.entries;
  }
  async answer(id: string, answer: McpAnswer) {
    this.answers.push({ id, answer });
  }
  async mayPropose(app: string, allow: boolean) {
    this.calls.push(["mayPropose", app, allow]);
    this.state.apps = this.state.apps.map((a) => (a.name === app ? { ...a, propose: allow } : a));
    this.state.proposers = this.state.proposers.filter((p) => p !== app);
    this.emitPending();
    return this.copy();
  }
  async mayRemember(app: string, allow: boolean) {
    this.calls.push(["mayRemember", app, allow]);
    this.state.apps = this.state.apps.map((a) => (a.name === app ? { ...a, remember: allow } : a));
    return this.copy();
  }
  async memoryFolder(root: string, folder: string) {
    this.calls.push(["memoryFolder", root, folder]);
    this.state.memoryFolders = { ...this.state.memoryFolders, [root]: folder };
    this.state.folders = (this.state.folders ?? []).filter((r) => r !== root);
    this.emitPending();
    return this.copy();
  }
  /** An app first uses memory in a Private Space whose Memory folder holds the user's own pages. */
  asksForFolder(root: string) {
    this.state.folders = [...(this.state.folders ?? []), root];
    this.emitPending();
  }
  async proposals() {
    const proposals: ConnectedAppProposal[] = this.kept.map(({ before: _b, after: _a, ...summary }) => summary);
    return { proposals, open: this.open() };
  }
  async proposal(id: string) {
    const found = this.kept.find((p) => p.id === id);
    if (!found) throw Object.assign(new Error(`No proposal ${id}`), { code: "NOT_FOUND" });
    return structuredClone(found);
  }
  async settle(id: string, status: "applied" | "declined" | "conflicted") {
    this.calls.push(["settle", id, status]);
    const found = this.kept.find((p) => p.id === id);
    if (!found) throw new Error(`No proposal ${id}`);
    found.status = status;
    if (status !== "conflicted") Object.assign(found, { before: null, after: null, settledAt: "2026-11-02T10:00:00Z" });
    this.emitProposals();
    const { before: _b, after: _a, ...summary } = found;
    return summary;
  }
  /** Apps that already have another thoth server; `install` refuses them with EEXIST unless replacing. */
  taken = new Set<string>();
  async install(app: string, replace?: boolean) {
    this.calls.push(replace ? ["install", app, true] : ["install", app]);
    if (this.taken.has(app) && !replace) throw Object.assign(new Error(`${app} already has a server called thoth`), { code: "EEXIST" });
    const replaced = this.taken.delete(app);
    return { status: replaced ? ("replaced" as const) : ("added" as const), file: `/Users/someone/.${app}/config`, backup: null };
  }
  /** What `skillLinks` answers (its `on` follows the settings). */
  linkReport: Omit<SkillLinksReport, "on"> = { linked: [], skipped: [], folders: ["/Users/someone/.agents/skills"] };
  async skillLinks(root: string, on?: boolean) {
    this.calls.push(on === undefined ? ["skillLinks", root] : ["skillLinks", root, on]);
    if (on !== undefined) {
      this.state.skillLinks = [...(this.state.skillLinks ?? []).filter((r) => r !== root), ...(on ? [root] : [])];
      this.emitPending();
    }
    const linked = (this.state.skillLinks ?? []).includes(root);
    return { on: linked, ...(linked ? this.linkReport : { linked: [], skipped: [] , folders: [] }) };
  }
  async memoryHistory() {
    return this.history.map(({ before: _b, after: _a, ...change }) => change);
  }
  async memoryChange(id: string) {
    const found = this.history.find((c) => c.id === id);
    if (!found) throw Object.assign(new Error(`No memory change ${id}`), { code: "NOT_FOUND" });
    return structuredClone(found);
  }
  async onMemories(listener: (written: MemoryWritten) => void) {
    this.memoryListeners.add(listener);
    return () => void this.memoryListeners.delete(listener);
  }
  /** An app wrote a memory without review: the host keeps it and tells the windows. */
  wrote(change: MemoryHistoryText) {
    this.history.unshift(change);
    for (const l of [...this.memoryListeners]) l({ app: change.app, action: change.action, root: change.root, space: change.space, path: change.path, title: change.title });
  }
  async onRequest(listener: (r: McpRequest) => void) {
    this.requests.add(listener);
    return () => void this.requests.delete(listener);
  }
  async onPending(listener: (apps: string[]) => void) {
    this.pendings.add(listener);
    return () => void this.pendings.delete(listener);
  }
  async onProposals(listener: (open: number) => void) {
    this.proposalListeners.add(listener);
    return () => void this.proposalListeners.delete(listener);
  }
  /** An app connects for the first time. */
  connect(app: string) {
    this.state.pending = [...this.state.pending, app];
    this.emitPending();
  }
  /** An allowed app proposes for the first time. */
  wantsToPropose(app: string) {
    this.state.proposers = [...this.state.proposers, app];
    this.emitPending();
  }
  /** An app's proposal reaches the host. */
  propose(proposal: Omit<ConnectedAppProposalText, "status" | "createdAt" | "expiresAt" | "pageId"> & { pageId?: string | null }) {
    this.kept.push({ pageId: null, status: "pending", createdAt: "2026-11-02T09:30:00Z", expiresAt: "2026-11-09T09:30:00Z", ...proposal });
    this.emitProposals();
  }
  open() {
    return this.kept.filter((p) => p.status === "pending" || p.status === "conflicted").length;
  }
  emitPending() {
    for (const l of [...this.pendings]) l([...this.state.pending]);
  }
  emitProposals() {
    for (const l of [...this.proposalListeners]) l(this.open());
  }
  request(r: McpRequest) {
    for (const l of [...this.requests]) l(r);
  }
}
