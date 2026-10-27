/**
 * Copy or move pages between two workspaces, on one server or on two (ADR-0006, amendment of 2026-10-27).
 *
 * Nothing new is asked of servers: it is the two transfers they already have, one at each end, with this client in
 * between. The record's own `id` is the to_workspace transfer at the destination; `source.operationId` is the
 * from_workspace transfer at the source (two IDs, because an operation ID is global on a server and the two ends can
 * be the same server).
 *
 *   plan      the selected pages and their sub-pages, parents first; a fresh destination ID for each.
 *   validate  both servers take transfers; read on the source (write for move), no export restriction, write at
 *             the destination; a top-level title already taken at the destination parent gets a free one.
 *   stage     createTransfer from_workspace at the source: the server pins one revision per page (and refuses an
 *             export-restricted workspace itself). The attachments those revisions link to are listed.
 *   transfer  copy each attachment (download, then upload with a recorded key), rewrite links through the ID
 *             mapping, record the hash of every payload, createTransfer to_workspace at the destination.
 *   verify    the destination's echo maps every page to the planned ID, all staged.
 *   commit_destination  commitTransfer at the destination, then read every created revision back and compare.
 *   finalize_source     commitTransfer at the source with the verified revisions; for move the source server
 *             deletes each page only if it is still the pinned revision (compare-and-swap).
 *
 * Before the destination commit, a stop rolls back both ends (each staged transfer is aborted); after it, the
 * operation can only go forward. The source is never deleted before a verified destination commit.
 */
import { FrontmatterError, updateFrontmatter } from "@thoth/content";
import { newStableId, sha256Hex, type TransferState } from "@thoth/domain";
import { ProblemError, type WorkspaceClient } from "@thoth/workspace-client";
import { hasCapability, isCompatibleProtocolVersion, roleCan, type Capabilities, type Limits, type TransferResource, type TreeNode, type Workspace } from "@thoth/workspace-protocol";
import { codeOf, isRefusal, messageOf, TransferInterrupted, TransferRefused } from "./errors.ts";
import { isFolderMarkdown } from "./folders.ts";
import { applyRewrites, attachmentIdsIn, classifyBetween, emptySummary, summarize, type ClassifiedReference } from "./links.ts";
import { isTerminal, listRecords, loadRecord, saveRecord, RECORD_VERSION, type AttachmentItem, type LinkSummary, type OperationRecord, type PageItem, type RecordStore } from "./record.ts";
import type { Availability, Preview, Problem, RecoveryReport, ServerAccess, Warning, WorkspaceSummary } from "./engine.ts";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const RETENTION_DAYS = 30;

export interface BetweenRequest {
  from: { server: string; workspace: string };
  to: { server: string; workspace: string; parentId: string | null };
  mode: "copy" | "move";
  /** Source page IDs; their sub-pages travel with them. */
  pageIds: string[];
  /** Copy the attachments the pages link to (when the destination lists `attachments`). */
  attachments: boolean;
}

export interface BetweenPreview {
  direction: "between_workspaces";
  request: BetweenRequest;
  /** The destination server (as `server` in the other previews). */
  server: { id: string; url: string };
  /** The destination workspace; undefined when it could not be read. */
  workspace?: WorkspaceSummary;
  source: { server: { id: string; url: string }; workspace?: WorkspaceSummary };
  limits: Limits;
  /** Everything that travels, parents before children: the selection and every page below it. */
  pages: { pageId: string; title: string; size: number; folder: boolean; parentId: string | null }[];
  /** Attachments the pages link to that are copied. */
  attachments: { id: string }[];
  links: LinkSummary;
  warnings: Warning[];
  problems: Problem[];
  canStart: boolean;
}

export interface BetweenOptions {
  records: RecordStore;
  server(id: string): ServerAccess | undefined;
  now?: () => Date;
  newId?: () => string;
  /** Test hook at every state boundary; throwing simulates a crash there. */
  checkpoint?: (point: string) => void | Promise<void>;
  onProgress?: (record: OperationRecord) => void;
}

class Halt extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super("halted at a checkpoint");
    this.reason = reason;
  }
}

const ORDER: readonly TransferState[] = ["plan", "validate", "stage", "transfer", "verify", "commit_destination", "finalize_source"];
const atLeast = (r: OperationRecord, s: TransferState) => ORDER.indexOf(r.state) >= ORDER.indexOf(s);
const beforeCommit = (r: OperationRecord) => ORDER.indexOf(r.state) < ORDER.indexOf("commit_destination");
/** The source server may have the from_workspace transfer once validation is recorded (it is created in that step). */
const sourceMayKnow = (r: OperationRecord) => r.source!.known || atLeast(r, "validate");
/** The destination may have the to_workspace transfer once the attachments were sent (it is created in that step). */
const destinationMayKnow = (r: OperationRecord) => r.serverKnown || atLeast(r, "stage");

export const isBetween = (r: { direction: string }): boolean => r.direction === "between_workspaces";

export class BetweenWorkspaces {
  private readonly records: RecordStore;
  private readonly options: BetweenOptions;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly running = new Map<string, Promise<OperationRecord>>();

  constructor(options: BetweenOptions) {
    this.records = options.records;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => newStableId(this.now().getTime()));
  }

  // --------------------------------------------------------------- preview

  /** What a transfer between two workspaces would do. Reads only, at both ends. */
  async previewBetweenWorkspaces(request: BetweenRequest): Promise<BetweenPreview> {
    const problems: Problem[] = [];
    const warnings: Warning[] = [];
    const from = this.options.server(request.from.server);
    const to = this.options.server(request.to.server);
    const base = {
      direction: "between_workspaces" as const,
      request,
      server: { id: request.to.server, url: to?.url ?? "" },
      source: { server: { id: request.from.server, url: from?.url ?? "" } },
      limits: {},
      pages: [],
      attachments: [],
      links: emptySummary(),
      warnings,
      problems,
    };
    if (request.pageIds.length === 0) problems.push({ code: "nothing_selected" });
    if (request.from.server === request.to.server && request.from.workspace === request.to.workspace) problems.push({ code: "same_workspace" });
    const [fromOk, toOk] = await Promise.all([availabilityOf(from), availabilityOf(to)]);
    for (const a of [fromOk, toOk]) if (!a.ok && !problems.some((p) => p.code === a.reason)) problems.push({ code: a.reason, message: a.message });
    if (!fromOk.ok || !toOk.ok || !from || !to) return { ...base, canStart: false };
    const limits = toOk.capabilities.limits ?? {};

    const [src, dst] = await Promise.all([workspaceOf(from, request.from.workspace), workspaceOf(to, request.to.workspace)]);
    if (!src) problems.push({ code: "source_workspace_not_found" });
    else {
      if (src.exportRestricted) problems.push({ code: "export_restricted" });
      if (request.mode === "move" && !roleCan(src.role, "write")) problems.push({ code: "source_forbidden", role: src.role });
    }
    if (!dst) problems.push({ code: "workspace_not_found" });
    else if (!roleCan(dst.role, "write")) problems.push({ code: "forbidden", role: dst.role });
    const summaries = { ...(dst ? { workspace: summaryOf(dst) } : {}), source: { ...base.source, ...(src ? { workspace: summaryOf(src) } : {}) } };
    // Nothing is read from a workspace that does not allow its pages out.
    if (!src || src.exportRestricted) return { ...base, ...summaries, limits, canStart: false };

    const tree = await from.client.getTree(src.id);
    const ids = withSubPages(tree.nodes, request.pageIds);
    const pages: BetweenPreview["pages"] = [];
    const markdown = new Map<string, string>();
    for (const id of ids) {
      let page;
      try {
        page = await from.client.getPage(src.id, id);
      } catch (error) {
        if (error instanceof ProblemError && error.status === 404) {
          problems.push({ code: "page_gone" });
          continue;
        }
        throw error;
      }
      markdown.set(id, page.markdown);
      const size = new TextEncoder().encode(page.markdown).length;
      pages.push({ pageId: id, title: page.metadata.title, size, folder: isFolderMarkdown(page.markdown), parentId: page.metadata.parentId });
      if (limits.maxMarkdownBytes !== undefined && size > limits.maxMarkdownBytes) problems.push({ code: "page_too_large", path: page.metadata.title, size, limit: limits.maxMarkdownBytes });
    }
    const linked = [...new Set([...markdown.values()].flatMap(attachmentIdsIn))];
    const copied = request.attachments && toOk.attachments && fromOk.attachments ? linked : [];
    if (request.attachments && linked.length > 0 && copied.length === 0) warnings.push({ code: "attachments_unsupported", count: linked.length });
    const included = new Map(pages.map((p) => [p.pageId, PLACEHOLDER]));
    const travelling = new Map<string, string | null>(copied.map((id) => [id, null]));
    const links = summarize(pages.flatMap((p) => classifyBetween(p.title, markdown.get(p.pageId)!, included, travelling)));
    if (links.counts.unresolved > 0) warnings.push({ code: "unresolved_links", count: links.counts.unresolved });
    if (links.counts.left_at_source > 0) warnings.push({ code: "left_at_source", count: links.counts.left_at_source });

    if (dst && limits.maxPagesPerWorkspace !== undefined) {
      const current = (await to.client.getTree(dst.id)).nodes.length;
      const adding = pages.length;
      if (current + adding > limits.maxPagesPerWorkspace) problems.push({ code: "quota", limit: limits.maxPagesPerWorkspace, current, adding });
      else if (current + adding > limits.maxPagesPerWorkspace * 0.9) warnings.push({ code: "quota_near", limit: limits.maxPagesPerWorkspace, current, adding });
    }
    const total = pages.reduce((n, p) => n + p.size, 0);
    if (total > MAX_REQUEST_BYTES) problems.push({ code: "too_large_total", size: total, limit: MAX_REQUEST_BYTES });
    return { ...base, ...summaries, limits, pages, attachments: copied.map((id) => ({ id })), links, canStart: problems.length === 0 };
  }

  // ------------------------------------------------------------------ runs

  async start(preview: Preview): Promise<OperationRecord> {
    if (preview.direction !== "between_workspaces") throw new TransferRefused("not_startable", "Only transfers between workspaces start here.");
    if (!preview.canStart || !preview.workspace || !preview.source.workspace) throw new TransferRefused("not_startable", "This transfer cannot start; see the preview.");
    const to = this.options.server(preview.server.id);
    const from = this.options.server(preview.source.server.id);
    if (!to || !from) throw new TransferRefused("server_unknown", "This server is no longer in the list.");
    const id = this.newId();
    const now = this.now().toISOString();
    // Every page gets an ID of the destination's own, for copy and move alike: a server never reuses a page ID,
    // and on one server the source's ID is still taken by the deleted original.
    const destIds = new Map(preview.pages.map((p) => [p.pageId, this.newId()]));
    const parent = preview.request.to.parentId;
    const items = preview.pages.map(
      (p): PageItem => ({
        kind: "page",
        ...(p.folder ? { folder: true } : {}),
        sourcePath: p.title,
        sourceId: p.pageId,
        sourceHash: null,
        sourceRevision: null,
        destId: destIds.get(p.pageId)!,
        destParentId: p.parentId !== null && destIds.has(p.parentId) ? destIds.get(p.parentId)! : parent,
        destPath: null,
        destHash: null,
        destRevision: null,
        title: p.title,
        state: "planned",
      }),
    );
    const record: OperationRecord = {
      recordVersion: RECORD_VERSION,
      id,
      kind: "transfer",
      direction: "between_workspaces",
      mode: preview.request.mode,
      server: { id: preview.server.id, url: to.url },
      workspace: { id: preview.workspace.id, name: preview.workspace.name },
      source: { server: { id: preview.source.server.id, url: from.url }, workspace: { id: preview.source.workspace.id, name: preview.source.workspace.name }, operationId: this.newId(), known: false },
      state: "plan",
      failedAt: null,
      destination: { parentId: parent, folder: "" },
      items,
      attachments: preview.attachments.map((a): AttachmentItem => ({ kind: "attachment", sourcePath: a.id, sourceHash: "", size: 0, mimeType: "", uploadKey: "", destId: null, destHash: null, state: "planned" })),
      links: preview.links,
      serverKnown: false,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    let saved: OperationRecord;
    try {
      saved = await this.save(record, "plan");
    } catch (error) {
      throw error instanceof Halt ? error.reason : error;
    }
    return this.exclusive(id, () => this.drive(saved));
  }

  resume(id: string): Promise<OperationRecord> {
    return this.exclusive(id, async () => {
      const record = await this.mustLoad(id);
      return isTerminal(record.state) ? record : this.drive(record);
    });
  }

  abort(id: string): Promise<OperationRecord> {
    return this.exclusive(id, async () => {
      const record = await this.mustLoad(id);
      if (isTerminal(record.state)) return record;
      if (!beforeCommit(record)) throw new TransferRefused("invalid_transfer_state", "This transfer has passed its commit and can only be finished.");
      try {
        return await this.rollback(record, "aborted", { code: "aborted", message: "Stopped by the user." });
      } catch (error) {
        throw error instanceof Halt ? error.reason : error;
      }
    });
  }

  async list(): Promise<OperationRecord[]> {
    return (await listRecords(this.records)).records.filter(isBetween);
  }

  get(id: string): Promise<OperationRecord | undefined> {
    return loadRecord(this.records, id);
  }

  async dismiss(id: string): Promise<void> {
    const record = await this.mustLoad(id);
    if (!isTerminal(record.state)) throw new TransferRefused("invalid_transfer_state", "An unfinished transfer cannot be dismissed.");
    await this.records.removeRecord(`.thoth/operations/${id}.json`);
  }

  /** Settles every unfinished transfer between workspaces: before its destination commit it is rolled back, after it finished. */
  async recover(): Promise<RecoveryReport> {
    const { records, invalid } = await listRecords(this.records);
    const report: RecoveryReport = { completed: [], rolledBack: [], waiting: [], invalid };
    const cutoff = this.now().getTime() - RETENTION_DAYS * 86_400_000;
    for (const r of records) {
      if (!isBetween(r)) continue;
      if ((r.state === "done" || r.state === "aborted" || r.state === "failed") && Date.parse(r.updatedAt) < cutoff) await this.records.removeRecord(`.thoth/operations/${r.id}.json`).catch(() => undefined);
      if (isTerminal(r.state)) continue;
      try {
        const settled = await this.exclusive(r.id, () => this.settle(r));
        (settled.state === "aborted" || settled.state === "failed" ? report.rolledBack : report.completed).push(settled);
      } catch (error) {
        report.waiting.push(error instanceof TransferInterrupted ? error.record : r);
      }
    }
    return report;
  }

  private async settle(record: OperationRecord): Promise<OperationRecord> {
    try {
      if (!beforeCommit(record)) return await this.drive(record);
      const interrupted = { code: "interrupted", message: "The app stopped before this transfer finished; it was rolled back and nothing changed at the destination." };
      if (destinationMayKnow(record)) {
        const access = this.access(record.server, record);
        const remote = await serverTransfer(access.client, record.id).catch((error: unknown) => {
          throw new TransferInterrupted(record, error);
        });
        if (remote && (remote.state === "done" || remote.state === "destination_committed_source_cleanup_pending")) return await this.drive({ ...record, state: "verify", serverKnown: true });
      }
      return await this.rollback(record, "aborted", interrupted);
    } catch (error) {
      throw error instanceof Halt ? error.reason : error;
    }
  }

  // ----------------------------------------------------------------- driver

  private exclusive(id: string, run: () => Promise<OperationRecord>): Promise<OperationRecord> {
    const current = this.running.get(id);
    const next = (current ?? Promise.resolve(undefined as unknown as OperationRecord)).catch(() => undefined).then(run);
    this.running.set(id, next);
    const clear = () => {
      if (this.running.get(id) === next) this.running.delete(id);
    };
    next.then(clear, clear);
    return next;
  }

  private async mustLoad(id: string): Promise<OperationRecord> {
    const record = await loadRecord(this.records, id);
    if (!record || !isBetween(record)) throw new TransferRefused("not_found", "No such transfer.");
    return record;
  }

  private async point(name: string): Promise<void> {
    if (!this.options.checkpoint) return;
    try {
      await this.options.checkpoint(name);
    } catch (error) {
      throw new Halt(error);
    }
  }

  private async save(record: OperationRecord, point?: string): Promise<OperationRecord> {
    const saved = await saveRecord(this.records, record, this.now());
    this.options.onProgress?.(saved);
    await this.point(`saved:${point ?? saved.state}`);
    return saved;
  }

  private access(end: { id: string; url: string }, record: OperationRecord): ServerAccess {
    const access = this.options.server(end.id);
    if (!access) throw new TransferInterrupted(record, new Error("The server of this transfer is not available."));
    if (access.url !== end.url) throw new TransferInterrupted(record, new Error("The server of this transfer changed its address."));
    return access;
  }

  private async drive(start: OperationRecord): Promise<OperationRecord> {
    try {
      let r = start;
      while (!isTerminal(r.state)) {
        try {
          r = await this.step(r);
        } catch (error) {
          if (error instanceof Halt) throw error;
          if (isRefusal(error) && beforeCommit(r)) {
            r = await this.rollback(r, "failed", { code: codeOf(error), message: messageOf(error) });
            continue;
          }
          const latest = (await loadRecord(this.records, r.id)) ?? r;
          const kept = await this.save({ ...latest, error: { code: codeOf(error), message: messageOf(error) } }, `error:${latest.state}`);
          throw new TransferInterrupted(kept, error instanceof TransferInterrupted ? error.message : error);
        }
      }
      return r;
    } catch (error) {
      throw error instanceof Halt ? error.reason : error;
    }
  }

  private step(r: OperationRecord): Promise<OperationRecord> {
    switch (r.state) {
      case "plan":
        return this.validate(r);
      case "validate":
        return this.stageSource(r);
      case "stage":
        return this.sendDestination(r);
      case "transfer":
        return this.verifyDestination(r);
      case "verify":
        return this.commitDestination(r);
      case "commit_destination":
      case "finalize_source":
        return this.finalizeSource(r);
      default:
        return Promise.resolve(r);
    }
  }

  /**
   * Rolls back both ends before the destination commit. A destination that answers 409 to the abort did commit
   * (a lost response): the operation then continues forward and is never reported as rolled back.
   */
  private async rollback(r: OperationRecord, state: "failed" | "aborted", error: { code: string; message: string }): Promise<OperationRecord> {
    const notes: string[] = [];
    if (destinationMayKnow(r)) {
      const access = this.options.server(r.server.id);
      if (access) {
        try {
          await this.point("before:abort:destination");
          await access.client.abortTransfer(r.id);
          await this.point("after:abort:destination");
        } catch (e) {
          if (e instanceof Halt) throw e;
          if (e instanceof ProblemError && e.code === "invalid_transfer_state") {
            const remote = await serverTransfer(access.client, r.id);
            if (remote && (remote.state === "done" || remote.state === "destination_committed_source_cleanup_pending")) return this.save({ ...r, state: "verify", serverKnown: true, error: null }, "rollback:committed");
          } else if (!(e instanceof ProblemError && e.status === 404)) notes.push(messageOf(e));
        }
      } else notes.push("The destination server is not available.");
    }
    if (sourceMayKnow(r)) {
      const access = this.options.server(r.source!.server.id);
      try {
        if (!access) throw new Error("The source server is not available.");
        await this.point("before:abort:source");
        await access.client.abortTransfer(r.source!.operationId);
        await this.point("after:abort:source");
      } catch (e) {
        if (e instanceof Halt) throw e;
        // 404: it never got there. Otherwise the staged transfer expires at the server; nothing was deleted.
        if (!(e instanceof ProblemError && e.status === 404)) notes.push(messageOf(e));
      }
    }
    const message = notes.length > 0 ? `${error.message} A staged transfer could not be discarded now (it expires on the server): ${notes.join(" ")}` : error.message;
    const items = r.items.map((i) => (i.state === "planned" || i.state === "staged" ? { ...i, state: "skipped" as const } : i));
    return this.save({ ...r, items, state, failedAt: r.state, error: { ...error, message } }, `rollback:${state}`);
  }

  // ------------------------------------------------------------------ steps

  private async validate(r: OperationRecord): Promise<OperationRecord> {
    const from = this.access(r.source!.server, r);
    const to = this.access(r.server, r);
    for (const access of [from, to]) {
      const caps = await access.client.getCapabilities();
      if (!hasCapability(caps, "transfers")) throw new TransferRefused("no_transfers", "This server does not accept transfers.");
    }
    const src = await workspaceOf(from, r.source!.workspace.id);
    if (!src) throw new TransferRefused("not_found", "The source workspace no longer exists, or you are no longer a member.");
    if (src.exportRestricted) throw new TransferRefused("export_restricted", "This workspace does not allow copying or moving its pages out.");
    if (r.mode === "move" && !roleCan(src.role, "write")) throw new TransferRefused("forbidden", "Your role in the source workspace does not allow moving pages out.");
    const dst = await workspaceOf(to, r.workspace.id);
    if (!dst) throw new TransferRefused("not_found", "The destination workspace no longer exists, or you are no longer a member.");
    if (!roleCan(dst.role, "write")) throw new TransferRefused("forbidden", "Your role in the destination workspace does not allow adding pages.");
    // No silent overwrite, and no two pages of one name side by side: a taken title gets the next free one.
    const tree = await to.client.getTree(dst.id);
    const taken = new Set(tree.nodes.filter((n) => n.parentId === r.destination.parentId).map((n) => n.title.toLocaleLowerCase()));
    const items = r.items.map((item) => {
      if (item.destParentId !== r.destination.parentId) return item;
      const title = freeTitle(item.title, taken);
      taken.add(title.toLocaleLowerCase());
      return { ...item, title };
    });
    return this.save({ ...r, items, state: "validate", error: null });
  }

  private async stageSource(r: OperationRecord): Promise<OperationRecord> {
    const from = this.access(r.source!.server, r);
    const sourceId = r.source!.workspace.id;
    let remote = await serverTransfer(from.client, r.source!.operationId);
    if (!remote) {
      await this.point("before:create:source");
      remote = await from.client.createTransfer(sourceId, { operationId: r.source!.operationId, direction: "from_workspace", mode: r.mode, pages: r.items.map((i) => ({ pageId: i.sourceId })) });
      await this.point("after:create:source");
    }
    if (remote.state === "aborted" || remote.state === "failed") throw new TransferRefused(remote.error?.code ?? "invalid_transfer_state", `The source server reports this transfer as ${remote.state}.`);
    const items: PageItem[] = [];
    const linked: string[] = [];
    for (const item of r.items) {
      const pinned = remote.items.find((i) => i.pageId === item.sourceId);
      if (!pinned?.revisionId) throw new TransferRefused("echo_mismatch", `The source server did not pin ${item.title}.`);
      const page = await from.client.getPage(sourceId, item.sourceId, { revision: pinned.revisionId });
      if (page.revision.id !== pinned.revisionId || sha256Hex(page.markdown) !== page.revision.contentHash) throw new TransferRefused("hash_mismatch", `The source server sent different content for ${item.title}.`);
      for (const a of attachmentIdsIn(page.markdown)) if (!linked.includes(a)) linked.push(a);
      items.push({ ...item, sourceRevision: pinned.revisionId, sourceHash: page.revision.contentHash, state: "staged" });
    }
    // Only attachments the pinned revisions still link to travel (the preview read the current ones).
    const attachments = r.attachments.map((a) => (linked.includes(a.sourcePath) ? a : { ...a, state: "skipped" as const, error: "not_linked" }));
    return this.save({ ...r, items, attachments, source: { ...r.source!, known: true }, state: "stage" });
  }

  private async sendDestination(r: OperationRecord): Promise<OperationRecord> {
    const from = this.access(r.source!.server, r);
    const to = this.access(r.server, r);
    let record = r;
    let remote = await serverTransfer(to.client, record.id);
    if (!remote) {
      for (const [i, a] of record.attachments.entries()) {
        if (a.state !== "planned") continue;
        let file: { bytes: Uint8Array; mimeType: string };
        try {
          file = await from.client.getAttachment(record.source!.workspace.id, a.sourcePath);
        } catch (error) {
          if (!(error instanceof ProblemError && error.status === 404)) throw error;
          record = await this.save(withAttachment(record, i, { ...a, state: "skipped", error: "source_missing" }), `skip:attachment:${i}`);
          continue;
        }
        const hash = sha256Hex(file.bytes);
        // The key depends only on what goes where, so a retry replays the first upload instead of storing it twice.
        const uploadKey = `thoth-attachment-${sha256Hex(`${record.server.url}\n${record.workspace.id}\n${record.source!.server.url}\n${record.source!.workspace.id}\n${a.sourcePath}\n${hash}`).slice(0, 40)}`;
        await this.point(`before:upload:${i}`);
        const uploaded = await to.client.uploadAttachment(record.workspace.id, file.bytes, file.mimeType, { idempotencyKey: uploadKey });
        await this.point(`after:upload:${i}`);
        if (uploaded.hash !== hash || uploaded.size !== file.bytes.length) throw new TransferRefused("hash_mismatch", "The destination stored different bytes for an attachment.");
        record = await this.save(withAttachment(record, i, { ...a, sourceHash: hash, size: file.bytes.length, mimeType: file.mimeType, uploadKey, destId: uploaded.id, destHash: uploaded.hash, state: "uploaded" }), `uploaded:${i}`);
      }
      const pages = new Map(record.items.map((i) => [i.sourceId, i.destId]));
      const attachments = new Map<string, string | null>(record.attachments.filter((a) => a.state === "uploaded" && a.destId).map((a) => [a.sourcePath, a.destId]));
      const payloads: string[] = [];
      const classified: ClassifiedReference[] = [];
      for (const item of record.items) {
        const page = await from.client.getPage(record.source!.workspace.id, item.sourceId, { revision: item.sourceRevision! });
        if (sha256Hex(page.markdown) !== item.sourceHash) throw new TransferRefused("hash_mismatch", `The source server sent different content for ${item.title}.`);
        const refs = classifyBetween(item.title, page.markdown, pages, attachments);
        classified.push(...refs);
        payloads.push(withOwnId(applyRewrites(page.markdown, refs, { labelBareWikilinks: false }), item.destId));
      }
      const total = payloads.reduce((n, m) => n + new TextEncoder().encode(m).length, 0);
      if (total > MAX_REQUEST_BYTES) throw new TransferRefused("payload_too_large", "These pages are too large to send together; select fewer.");
      // Durable before sending: the hash of exactly what the destination receives.
      record = await this.save({ ...record, items: record.items.map((item, i) => ({ ...item, destHash: sha256Hex(payloads[i]!) })), links: summarize(classified) }, "payloads");
      await this.point("before:create");
      remote = await to.client.createTransfer(record.workspace.id, {
        operationId: record.id,
        direction: "to_workspace",
        mode: record.mode,
        pages: record.items.map((item, i) => ({ sourceId: item.sourceId, pageId: item.destId, parentId: item.destParentId, title: item.title.slice(0, 500) || "Untitled", markdown: payloads[i]! })),
        ...(attachments.size > 0 ? { attachmentIds: [...attachments.values()] as string[] } : {}),
      });
      await this.point("after:create");
    }
    if (remote.state === "aborted" || remote.state === "failed") throw new TransferRefused(remote.error?.code ?? "invalid_transfer_state", `The destination reports this transfer as ${remote.state}.`);
    return this.save({ ...record, serverKnown: true, state: "transfer" });
  }

  private async verifyDestination(r: OperationRecord): Promise<OperationRecord> {
    const to = this.access(r.server, r);
    const remote = await serverTransfer(to.client, r.id);
    if (!remote) throw new TransferRefused("not_found", "The destination no longer knows this transfer.");
    if (remote.state === "aborted" || remote.state === "failed") throw new TransferRefused(remote.error?.code ?? "invalid_transfer_state", `The destination reports this transfer as ${remote.state}.`);
    const committed = remote.state === "done";
    if (remote.items.length !== r.items.length) throw new TransferRefused("echo_mismatch", "The destination staged a different set of pages.");
    for (const item of r.items) {
      const echoed = remote.items.find((i) => i.pageId === item.destId);
      if (!echoed || echoed.sourceId !== item.sourceId || (!committed && echoed.state !== "staged")) throw new TransferRefused("echo_mismatch", `The destination's copy of ${item.title} does not match the plan.`);
    }
    return this.save({ ...r, state: "verify" });
  }

  private async commitDestination(r: OperationRecord): Promise<OperationRecord> {
    const to = this.access(r.server, r);
    await this.point("before:commit");
    const result = await to.client.commitTransfer(r.id);
    await this.point("after:commit");
    if (result.state !== "done") throw new TransferRefused(result.error?.code ?? "invalid_transfer_state", `The destination reports this transfer as ${result.state}.`);
    const items: PageItem[] = [];
    for (const item of r.items) {
      const revisionId = result.items.find((i) => i.pageId === item.destId)?.revisionId ?? null;
      let ok = false;
      if (revisionId) {
        try {
          const page = await to.client.getPage(r.workspace.id, item.destId, { revision: revisionId });
          ok = page.revision.contentHash === item.destHash && sha256Hex(page.markdown) === item.destHash;
        } catch (error) {
          if (!(error instanceof ProblemError)) throw error; // network: the step runs again (commit replays)
        }
      }
      items.push(ok ? { ...item, destRevision: revisionId, state: "committed" } : { ...item, destRevision: revisionId, state: "failed", error: "hash_mismatch" });
    }
    const attachments = r.attachments.map((a) => (a.state === "uploaded" ? { ...a, state: "committed" as const } : a));
    return this.save({ ...r, items, attachments, serverKnown: true, state: "commit_destination", error: null });
  }

  private async finalizeSource(r: OperationRecord): Promise<OperationRecord> {
    const from = this.access(r.source!.server, r);
    let record = r.state === "finalize_source" ? r : await this.save({ ...r, state: "finalize_source" });
    const failed = record.items.filter((i) => i.state === "failed" || (i.state === "cleanup_pending" && i.error === "hash_mismatch"));
    if (record.mode === "move" && failed.length > 0) {
      // A move commits at the source only with every page verified at the destination. One is not, so every
      // original stays: the source transfer is discarded and nothing is deleted there.
      try {
        await this.point("before:abort:source");
        await from.client.abortTransfer(record.source!.operationId);
        await this.point("after:abort:source");
      } catch (error) {
        if (error instanceof Halt || !(error instanceof ProblemError)) throw error;
      }
      const items = record.items.map((i) => ({ ...i, state: "cleanup_pending" as const, error: i.state === "failed" || i.error === "hash_mismatch" ? "hash_mismatch" : "kept_with_others" }));
      return this.save({ ...record, items, state: "destination_committed_source_cleanup_pending", error: null });
    }
    const verified = record.items.filter((i) => i.state !== "failed").map((i) => ({ pageId: i.sourceId, revisionId: i.sourceRevision!, contentHash: i.sourceHash! }));
    let result: TransferResource;
    try {
      await this.point("before:commit:source");
      result = await from.client.commitTransfer(record.source!.operationId, { verified });
      await this.point("after:commit:source");
    } catch (error) {
      if (error instanceof Halt || !isRefusal(error)) throw error;
      // The pages are safely at the destination; the source would not finalize. A move keeps its originals: say so.
      const items = record.items.map((i) => ({ ...i, state: record.mode === "move" ? ("cleanup_pending" as const) : ("committed" as const), error: codeOf(error) }));
      return this.save({ ...record, items, state: record.mode === "move" ? "destination_committed_source_cleanup_pending" : "done", error: { code: codeOf(error), message: messageOf(error) } });
    }
    const items = record.items.map((item) => {
      const remote = result.items.find((i) => i.pageId === item.sourceId);
      if (item.state === "failed") return item; // a copy not verified at the destination; its original is unchanged
      if (remote?.state === "failed") return { ...item, state: "cleanup_pending" as const, error: remote.error ?? "revision_conflict" };
      return { ...item, state: record.mode === "move" ? ("source_deleted" as const) : ("committed" as const) };
    });
    const state = result.state === "destination_committed_source_cleanup_pending" || items.some((i) => i.state === "cleanup_pending") ? "destination_committed_source_cleanup_pending" : "done";
    const unverified = items.filter((i) => i.state === "failed").length;
    return this.save({ ...record, items, state, error: unverified === 0 ? null : { code: "hash_mismatch", message: `${unverified} page(s) could not be verified at the destination; the originals are unchanged.` } });
  }
}

const PLACEHOLDER = "00000000-0000-7000-8000-000000000000";

async function availabilityOf(access: ServerAccess | undefined): Promise<Availability> {
  if (!access) return { ok: false, reason: "server_unknown", message: "This server is no longer in the list." };
  let capabilities: Capabilities;
  try {
    capabilities = await access.client.getCapabilities();
  } catch (error) {
    return { ok: false, reason: "unreachable", message: messageOf(error) };
  }
  if (!isCompatibleProtocolVersion(capabilities.protocolVersion)) return { ok: false, reason: "incompatible", message: `The server speaks protocol ${capabilities.protocolVersion}.` };
  if (!hasCapability(capabilities, "transfers")) return { ok: false, reason: "no_transfers", message: "This server does not accept transfers." };
  return { ok: true, capabilities, attachments: hasCapability(capabilities, "attachments") };
}

async function workspaceOf(access: ServerAccess, id: string): Promise<Workspace | undefined> {
  return (await access.client.listWorkspaces().catch(() => [] as Workspace[])).find((w) => w.id === id);
}

async function serverTransfer(client: WorkspaceClient, id: string): Promise<TransferResource | undefined> {
  try {
    return await client.getTransfer(id);
  } catch (error) {
    if (error instanceof ProblemError && error.status === 404) return undefined;
    throw error;
  }
}

function summaryOf(ws: Workspace): WorkspaceSummary {
  return { id: ws.id, name: ws.name, role: ws.role, exportRestricted: ws.exportRestricted, memberCount: ws.memberCount, ...(ws.members ? { members: ws.members } : {}) };
}

/** The selection and every page below it, parents before children; each page once. */
export function withSubPages(nodes: readonly Pick<TreeNode, "id" | "parentId">[], selected: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const children = new Map<string, string[]>();
  for (const n of nodes) if (n.parentId !== null) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  const known = new Set(nodes.map((n) => n.id));
  // A selected page inside another selected page comes with it, not on its own.
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
  const insideSelection = (id: string) => {
    for (let p = parentOf.get(id) ?? null, depth = 0; p !== null && depth < 1000; p = parentOf.get(p) ?? null, depth++) if (selected.includes(p)) return true;
    return false;
  };
  const queue = selected.filter((id) => !known.has(id) || !insideSelection(id));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
}

/** `title`, or `title 2`, `title 3`… when it is taken among `taken` (lower-cased). */
function freeTitle(title: string, taken: ReadonlySet<string>): string {
  if (!taken.has(title.toLocaleLowerCase())) return title;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${title} ${n}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${title} ${Date.now()}`;
}

/** A page that names its own ID in frontmatter (`thoth_id`) names the destination's; others are left as they are. */
function withOwnId(markdown: string, id: string): string {
  const current = /^\uFEFF?---\r?\n[\s\S]*?^thoth_id:[ \t]*["']?([0-9a-f-]{36})["']?[ \t]*$/m.exec(markdown)?.[1];
  if (current === undefined || current === id) return markdown;
  try {
    return updateFrontmatter(markdown, { thoth_id: id });
  } catch (error) {
    if (error instanceof FrontmatterError) return markdown;
    throw error;
  }
}

function withAttachment(r: OperationRecord, index: number, item: AttachmentItem): OperationRecord {
  return { ...r, attachments: r.attachments.map((x, i) => (i === index ? item : x)) };
}
