/**
 * A fake of the host's Connected apps (ADR-0021, ADR-0048) for the desktop tests: the settings, the questions, the
 * requests a window answers, and the proposals the host keeps.
 */
import type { ConnectedAppProposal, ConnectedAppProposalText, ConnectedApps, ConnectedAppsLogEntry, ConnectedAppsSettings, McpAnswer, McpRequest } from "@thoth/platform";

export const SIDECAR = "/Applications/Thoth.app/Contents/MacOS/thoth-mcp";
export const SOCKET = "/Users/someone/Library/Application Support/com.thothnotes.desktop/mcp/thoth.sock";

export class FakeConnectedApps implements ConnectedApps {
  state: ConnectedAppsSettings = { available: true, enabled: false, listening: false, error: null, spaces: [], apps: [], pending: [], proposers: [], setup: { command: SIDECAR, args: ["--socket", SOCKET] } };
  calls: unknown[][] = [];
  answers: { id: string; answer: McpAnswer }[] = [];
  entries: ConnectedAppsLogEntry[] = [];
  /** The proposals kept, with their text. */
  kept: ConnectedAppProposalText[] = [];
  private readonly requests = new Set<(r: McpRequest) => void>();
  private readonly pendings = new Set<(apps: string[]) => void>();
  private readonly proposalListeners = new Set<(open: number) => void>();

  private copy = () => structuredClone(this.state);
  async settings() {
    return this.copy();
  }
  async configure(change: { enabled?: boolean; spaces?: string[] }) {
    this.calls.push(["configure", change]);
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
