/**
 * The transfer engine (ADR-0006): copy or move pages between the Private Space
 * and a workspace, crash-safe at every step.
 *
 * States: PLAN → VALIDATE → STAGE → TRANSFER → VERIFY → COMMIT_DESTINATION →
 * FINALIZE_SOURCE (move) → DONE, plus FAILED, ABORTED and
 * `destination_committed_source_cleanup_pending`. Each state is recorded in
 * `.thoth/operations/<id>.json` once its work is done, and each step can run
 * again from the last record without repeating an effect: the operation ID is
 * the idempotency key at the server, uploads carry their own recorded key, and
 * local writes are recognized by their recorded hash.
 *
 * Private → Workspace
 *   plan      the selected pages and attachments, the destination parent.
 *   validate  capability, role, limits; adopt `thoth_id` (ADR-0003); hash the sources.
 *   stage     upload attachments (idempotent) and check the hash the server echoes.
 *   transfer  rewrite links through the ID mapping, record the hash of each payload, createTransfer
 *             (pages staged invisibly at the server).
 *   verify    the server's echo maps every source to the planned page ID, all staged.
 *   commit_destination  commitTransfer, then read back every created revision and compare hashes.
 *   finalize_source     (move) delete each source only if it still has the hash it was sent with
 *             (`Vault.deleteFileAtomic`); an edited source is kept and the item is cleanup-pending.
 *
 * Workspace → Private
 *   plan      the selected pages and the destination folder.
 *   validate  capability, export restriction (ADR-0009), role for move.
 *   stage     createTransfer from_workspace: the server pins one revision per page.
 *   transfer  download exactly those revisions, check their hashes, write each file with
 *             compare-and-swap (never over another file; the same page edited locally becomes a
 *             conflict copy, ADR-0005).
 *   verify    re-read every written file and compare hashes.
 *   commit_destination  the local files are final; the ID mapping is recorded in `.thoth/sync/`.
 *   finalize_source     commitTransfer with the verified entries; for move the server deletes each
 *             source only if it is still the verified revision.
 *
 * The commit is the point of no return. Recovery on open (`recover`) rolls back
 * an operation interrupted before it (the server transfer is aborted, our own
 * unedited local files are removed) and rolls forward one interrupted after it.
 * The source is never deleted before a verified destination commit.
 */
import { FrontmatterError, LinkResolver, NotEditableError, updateFrontmatter } from "@thoth/content";
import { basename, collisionKey, dirname, isStableId, joinVaultPath, newStableId, normalizeVaultPath, sha256Hex, type TransferState } from "@thoth/domain";
import { ConflictError, NotFoundError, type Vault } from "@thoth/local-store";
import { ProblemError, type WorkspaceClient } from "@thoth/workspace-client";
import { hasCapability, isCompatibleProtocolVersion, roleCan, type Capabilities, type Limits, type Member, type Role, type TransferResource, type Workspace } from "@thoth/workspace-protocol";
import {
  applyRewrites,
  classifyInbound,
  classifyOutbound,
  compactInbound,
  emptySummary,
  fileNameForTitle,
  outboundResolver,
  referencedAttachments,
  summarize,
  type ClassifiedReference,
  type InboundContext,
  type OutboundContext,
} from "./links.ts";
import { folderMarkdown, folderNameForTitle, folderTitle, isFolderMarkdown, planInboundFolders, planOutboundFolders } from "./folders.ts";
import { isTerminal, listRecords, loadRecord, saveRecord, type AttachmentItem, type LinkSummary, type OperationRecord, type PageItem, RECORD_VERSION } from "./record.ts";
import { loadSync, projectAllSync, recordMappings, type SyncEntry, type SyncRecord } from "./sync.ts";

/** The host's request body limit for one protocol call (crates/thoth-host `MAX_BODY`). */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
/** Completed records older than this are removed on open; cleanup-pending ones are kept until dismissed. */
export const RECORD_RETENTION_DAYS = 30;

export interface ServerAccess {
  client: WorkspaceClient;
  /** The server's origin, for records and `.thoth/sync/`. */
  url: string;
}

export interface TransferEngineOptions {
  vault: Vault;
  /** The protocol client for a server the host knows (it adds the credential), or undefined when the server is gone. */
  server(id: string): ServerAccess | undefined;
  now?: () => Date;
  newId?: () => string;
  /**
   * Test hook, called at every state boundary (after each durable write, before and after each server call
   * and each local write). Throwing simulates a crash right there: nothing more is recorded.
   */
  checkpoint?: (point: string) => void | Promise<void>;
  /** Called after every durable state change. */
  onProgress?: (record: OperationRecord) => void;
}

export type Unavailable = "server_unknown" | "unreachable" | "signed_out" | "incompatible" | "no_transfers";

export type Availability = { ok: true; capabilities: Capabilities; attachments: boolean } | { ok: false; reason: Unavailable; message: string };

/** Something that stops a transfer before it starts; shown in the preview. */
export type Problem =
  | { code: Unavailable; message: string }
  | { code: "workspace_not_found" }
  | { code: "forbidden"; role: Role }
  | { code: "export_restricted" }
  | { code: "not_editable"; path: string }
  | { code: "malformed_frontmatter"; path: string }
  | { code: "page_too_large"; path: string; size: number; limit: number }
  | { code: "too_large_total"; size: number; limit: number }
  | { code: "quota"; limit: number; current: number; adding: number }
  | { code: "bad_folder"; folder: string }
  | { code: "nothing_selected" };

/** Something the user should know before confirming; it does not block. */
export type Warning =
  | { code: "unresolved_links"; count: number }
  | { code: "left_at_source"; count: number }
  | { code: "attachments_unsupported"; count: number }
  | { code: "attachment_too_large"; path: string; size: number; limit: number }
  | { code: "attachments_stay_in_workspace"; count: number }
  | { code: "quota_near"; limit: number; current: number; adding: number };

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  exportRestricted: boolean;
  memberCount: number;
  /** Absent when the server does not disclose members to the caller. */
  members?: Member[];
}

export interface ToWorkspaceRequest {
  server: string;
  workspace: string;
  /** Parent page in the workspace; null for the top level. */
  parentId: string | null;
  mode: "copy" | "move";
  /** Vault paths of the selected pages. */
  paths: string[];
  /** Upload the attachments the pages link to (when the server lists `attachments`). */
  attachments: boolean;
  /**
   * The vault folder the selection is taken relative to. Every folder below it on the way to a selected page
   * travels as a folder page (ADR-0016 rule 3). Default: the deepest folder holding every selected page; pass a
   * selected folder's parent so the folder itself travels.
   */
  base?: string;
}

export interface FromWorkspaceRequest {
  server: string;
  workspace: string;
  mode: "copy" | "move";
  pageIds: string[];
  /** Vault folder for pages that have no earlier place; "" is the vault root. */
  folder: string;
}

interface PreviewBase {
  server: { id: string; url: string };
  /** Undefined when the workspace could not be read. */
  workspace?: WorkspaceSummary;
  limits: Limits;
  links: LinkSummary;
  warnings: Warning[];
  problems: Problem[];
  canStart: boolean;
}

export interface ToWorkspacePreview extends PreviewBase {
  direction: "to_workspace";
  request: ToWorkspaceRequest;
  pages: { path: string; title: string; size: number; thothId: string | null }[];
  /** Vault folders that become folder pages, parents first. */
  folders: string[];
  attachments: { path: string; size: number; mimeType: string; hash: string }[];
}

export interface FromWorkspacePreview extends PreviewBase {
  direction: "from_workspace";
  request: FromWorkspaceRequest;
  /** `folder`: a folder page (`thoth_kind: folder`), which becomes a vault folder. */
  pages: { pageId: string; title: string; size: number; folder: boolean; parentId: string | null }[];
}

export type Preview = ToWorkspacePreview | FromWorkspacePreview;

export interface RecoveryReport {
  /** Finished after the restart (they had passed their commit). */
  completed: OperationRecord[];
  /** Interrupted before their commit and rolled back: nothing changed at the destination. */
  rolledBack: OperationRecord[];
  /** Could not be settled now (server unknown, signed out or unreachable); tried again next time. */
  waiting: OperationRecord[];
  /** Files in `.thoth/operations/` that are not valid records; left in place. */
  invalid: string[];
}

/** A known refusal: the operation stops and, before its commit, is rolled back. */
export class TransferRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TransferRefused";
    this.code = code;
  }
}

/** The operation could not continue for now (network, server, sign-in); its record keeps the last durable state. */
export class TransferInterrupted extends Error {
  readonly record: OperationRecord;
  constructor(record: OperationRecord, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TransferInterrupted";
    this.record = record;
  }
}

/** Thrown through every layer when the checkpoint hook throws (a simulated crash). */
class Halt extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super("halted at a checkpoint");
    this.reason = reason;
  }
}

const ORDER: readonly TransferState[] = ["plan", "validate", "stage", "transfer", "verify", "commit_destination", "finalize_source"];
const before = (a: TransferState, b: TransferState) => ORDER.indexOf(a) < ORDER.indexOf(b);
/** Before the destination commit: rollback is still possible and leaves no trace at the destination. */
const beforeCommit = (r: OperationRecord) => r.state === "plan" || r.state === "validate" || r.state === "stage" || r.state === "transfer" || r.state === "verify";

function isRefusal(error: unknown): error is ProblemError | TransferRefused {
  if (error instanceof TransferRefused) return true;
  return error instanceof ProblemError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
}

const codeOf = (error: unknown): string => (error instanceof TransferRefused || error instanceof ProblemError ? error.code : "interrupted");
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class TransferEngine {
  private readonly vault: Vault;
  private readonly options: TransferEngineOptions;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** One run per operation at a time. */
  private readonly running = new Map<string, Promise<OperationRecord>>();

  constructor(options: TransferEngineOptions) {
    this.vault = options.vault;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => newStableId(this.now().getTime()));
  }

  // ------------------------------------------------------------- discovery

  /** Whether transfers can be offered for a server, and why not. Nothing is sent but `GET /capabilities`. */
  async availability(serverId: string): Promise<Availability> {
    const access = this.options.server(serverId);
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

  private async workspaceOf(access: ServerAccess, id: string): Promise<Workspace | undefined> {
    return (await access.client.listWorkspaces()).find((w) => w.id === id);
  }

  // --------------------------------------------------------------- preview

  /**
   * What a Private → Workspace transfer would do, before anything leaves the computer: who can see the pages,
   * how every link is classified, and what blocks or deserves a warning. Reads only (vault and server).
   */
  async previewToWorkspace(request: ToWorkspaceRequest): Promise<ToWorkspacePreview> {
    const access = this.options.server(request.server);
    const problems: Problem[] = [];
    const warnings: Warning[] = [];
    const base = { direction: "to_workspace" as const, request, server: { id: request.server, url: access?.url ?? "" }, links: emptySummary(), limits: {}, warnings, problems };
    if (request.paths.length === 0) problems.push({ code: "nothing_selected" });
    const availability = await this.availability(request.server);
    if (!availability.ok || !access) {
      if (!availability.ok) problems.push({ code: availability.reason, message: availability.message });
      return { ...base, pages: [], folders: [], attachments: [], canStart: false };
    }
    const limits = availability.capabilities.limits ?? {};
    const ws = await this.workspaceOf(access, request.workspace).catch(() => undefined);
    if (!ws) problems.push({ code: "workspace_not_found" });
    else if (!roleCan(ws.role, "write")) problems.push({ code: "forbidden", role: ws.role });

    const pages: ToWorkspacePreview["pages"] = [];
    const sources: { path: string; source: string }[] = [];
    for (const path of request.paths) {
      const read = await this.vault.readPage(path);
      const thothId = read.document.thothId ?? null;
      pages.push({ path: read.path, title: read.document.title, size: new TextEncoder().encode(read.source).length, thothId });
      sources.push({ path: read.path, source: read.source });
      if (!read.editable) problems.push({ code: "not_editable", path: read.path });
      else if (read.document.frontmatterError !== undefined) problems.push({ code: "malformed_frontmatter", path: read.path });
      if (limits.maxMarkdownBytes !== undefined && pages.at(-1)!.size > limits.maxMarkdownBytes) problems.push({ code: "page_too_large", path: read.path, size: pages.at(-1)!.size, limit: limits.maxMarkdownBytes });
    }

    const folders = planOutboundFolders(pages.map((p) => p.path), request.base).folders.map((f) => f.path);
    const tree = ws ? await access.client.getTree(ws.id).catch(() => undefined) : undefined;
    const ctx = await this.outboundContext(access.url, request.workspace, tree?.nodes.map((n) => n.id) ?? [], new Map(pages.map((p) => [p.path, PLACEHOLDER_ID])), new Map());
    const resolver = outboundResolver(ctx);
    const vaultAttachments = new Map((await this.vault.listAttachments()).map((a) => [a.path, a]));
    const linked = referencedAttachments(sources, resolver).filter((path) => !ctx.mappedAttachments.has(path));
    const attachments: ToWorkspacePreview["attachments"] = [];
    if (request.attachments && linked.length > 0) {
      if (!availability.attachments) warnings.push({ code: "attachments_unsupported", count: linked.length });
      else {
        for (const path of linked) {
          const a = vaultAttachments.get(path);
          if (!a) continue;
          if (limits.maxAttachmentBytes !== undefined && a.size > limits.maxAttachmentBytes) warnings.push({ code: "attachment_too_large", path, size: a.size, limit: limits.maxAttachmentBytes });
          else attachments.push({ path, size: a.size, mimeType: a.mimeType, hash: a.hash });
        }
      }
    }
    const included = new Map<string, string | null>(attachments.map((a) => [a.path, null]));
    const classified = sources.flatMap((s) => classifyOutbound(s.path, s.source, { ...ctx, includedAttachments: included }, resolver));
    const links = summarize(classified);
    addLinkWarnings(links, warnings);

    if (tree && limits.maxPagesPerWorkspace !== undefined) {
      const current = tree.nodes.length;
      const adding = pages.length + folders.length;
      if (current + adding > limits.maxPagesPerWorkspace) problems.push({ code: "quota", limit: limits.maxPagesPerWorkspace, current, adding });
      else if (current + adding > limits.maxPagesPerWorkspace * 0.9) warnings.push({ code: "quota_near", limit: limits.maxPagesPerWorkspace, current, adding });
    }
    const total = pages.reduce((n, p) => n + p.size, 0);
    if (total > MAX_REQUEST_BYTES) problems.push({ code: "too_large_total", size: total, limit: MAX_REQUEST_BYTES });
    return { ...base, ...(ws ? { workspace: summaryOf(ws) } : {}), limits, links, pages, folders, attachments, canStart: problems.length === 0 };
  }

  /** What a Workspace → Private transfer would do. Downloads the current revisions to classify their links; writes nothing. */
  async previewFromWorkspace(request: FromWorkspaceRequest): Promise<FromWorkspacePreview> {
    const access = this.options.server(request.server);
    const problems: Problem[] = [];
    const warnings: Warning[] = [];
    const base = { direction: "from_workspace" as const, request, server: { id: request.server, url: access?.url ?? "" }, links: emptySummary(), limits: {}, warnings, problems };
    if (request.pageIds.length === 0) problems.push({ code: "nothing_selected" });
    const availability = await this.availability(request.server);
    if (!availability.ok || !access) {
      if (!availability.ok) problems.push({ code: availability.reason, message: availability.message });
      return { ...base, pages: [], canStart: false };
    }
    try {
      normalizeFolder(request.folder);
    } catch {
      problems.push({ code: "bad_folder", folder: request.folder });
    }
    const ws = await this.workspaceOf(access, request.workspace).catch(() => undefined);
    if (!ws) {
      problems.push({ code: "workspace_not_found" });
      return { ...base, pages: [], limits: availability.capabilities.limits ?? {}, canStart: false };
    }
    if (ws.exportRestricted) problems.push({ code: "export_restricted" });
    if (request.mode === "move" && !roleCan(ws.role, "write")) problems.push({ code: "forbidden", role: ws.role });
    const pages: FromWorkspacePreview["pages"] = [];
    let links = emptySummary();
    if (!ws.exportRestricted) {
      const downloaded: { pageId: string; title: string; markdown: string }[] = [];
      for (const pageId of request.pageIds) {
        const page = await access.client.getPage(ws.id, pageId);
        const folder = isFolderMarkdown(page.markdown);
        if (!folder) downloaded.push({ pageId, title: page.metadata.title, markdown: page.markdown });
        pages.push({ pageId, title: page.metadata.title, size: page.revision.size, folder, parentId: page.metadata.parentId });
      }
      const sync = await loadSync(this.vault, access.url, ws.id);
      const chains = planInboundFolders(pages);
      const planned = new Map(downloaded.map((d) => [d.pageId, joinVaultPath(...pathParts(request.folder), ...(chains.get(d.pageId) ?? []), fileNameForTitle(d.title))]));
      const ctx = await this.inboundContext(sync, planned);
      const refs = downloaded.flatMap((d) => classifyInbound(planned.get(d.pageId)!, d.markdown, ctx));
      links = summarize(refs);
      addLinkWarnings(links, warnings, { attachmentsStay: countAttachmentsLeft(refs) });
    }
    return { ...base, workspace: summaryOf(ws), limits: availability.capabilities.limits ?? {}, links, pages, canStart: problems.length === 0 };
  }

  // ------------------------------------------------------------------ runs

  /** Records the plan (PLAN) and runs the transfer. Throws `TransferInterrupted` when it has to stop for now. */
  async start(preview: Preview): Promise<OperationRecord> {
    if (!preview.canStart || !preview.workspace) throw new TransferRefused("not_startable", "This transfer cannot start; see the preview.");
    const access = this.options.server(preview.server.id);
    if (!access) throw new TransferRefused("server_unknown", "This server is no longer in the list.");
    const now = this.now().toISOString();
    const id = this.newId();
    const mode = preview.request.mode;
    let items: PageItem[];
    let attachments: AttachmentItem[] = [];
    let destination: OperationRecord["destination"];
    if (preview.direction === "to_workspace") {
      destination = { parentId: preview.request.parentId, folder: "" };
      // Folders first, parents before children, each a new folder page (ADR-0016 rule 3).
      const plan = planOutboundFolders(preview.pages.map((p) => p.path), preview.request.base);
      const folderIds = new Map<string, string>();
      const folderItems = plan.folders.map((f): PageItem => {
        const destId = this.newId();
        folderIds.set(f.path, destId);
        return {
          kind: "page",
          folder: true,
          sourcePath: f.path,
          sourceId: `folder:${f.path}`,
          sourceHash: null,
          sourceRevision: null,
          destId,
          destParentId: f.parent === null ? preview.request.parentId : folderIds.get(f.parent)!,
          destPath: null,
          destHash: null,
          destRevision: null,
          title: folderTitle(f.path).slice(0, 500),
          state: "planned",
        };
      });
      const parentFor = (path: string): string | null => {
        const folder = plan.parentOf.get(path) ?? null;
        return folder === null ? preview.request.parentId : folderIds.get(folder)!;
      };
      items = [
        ...folderItems,
        ...preview.pages.map((p): PageItem => ({
          kind: "page",
          sourcePath: p.path,
          sourceId: p.thothId ?? "",
          sourceHash: null,
          sourceRevision: null,
          destId: mode === "copy" ? this.newId() : (p.thothId ?? ""),
          destParentId: parentFor(p.path),
          destPath: null,
          destHash: null,
          destRevision: null,
          title: p.title,
          state: "planned",
        })),
      ];
      // The upload key depends only on what is uploaded where, so a retry (even by a new operation after a
      // rollback) replays the first upload within the server's idempotency window instead of storing it twice.
      const workspaceId = preview.workspace.id;
      attachments = preview.attachments.map((a) => ({ kind: "attachment", sourcePath: a.path, sourceHash: a.hash, size: a.size, mimeType: a.mimeType, uploadKey: `thoth-attachment-${sha256Hex(`${access.url}\n${workspaceId}\n${a.path}\n${a.hash}`).slice(0, 40)}`, destId: null, destHash: null, state: "planned" }));
    } else {
      destination = { parentId: null, folder: normalizeFolder(preview.request.folder) };
      const selected = new Set(preview.pages.map((p) => p.pageId));
      items = preview.pages.map((p): PageItem => ({
        kind: "page",
        ...(p.folder ? { folder: true } : {}),
        sourcePath: p.title,
        sourceId: p.pageId,
        sourceHash: null,
        sourceRevision: null,
        destId: mode === "copy" ? this.newId() : p.pageId,
        // The parent workspace page, when it is selected too: the page then lands inside that folder.
        destParentId: p.parentId !== null && selected.has(p.parentId) ? p.parentId : null,
        destPath: null,
        destHash: null,
        destRevision: null,
        title: p.title,
        state: "planned",
      }));
    }
    const record: OperationRecord = {
      recordVersion: RECORD_VERSION,
      id,
      kind: "transfer",
      direction: preview.direction,
      mode,
      server: { id: preview.server.id, url: access.url },
      workspace: { id: preview.workspace.id, name: preview.workspace.name },
      state: "plan",
      failedAt: null,
      destination,
      items,
      attachments,
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
      if (error instanceof Halt) throw error.reason;
      throw error;
    }
    return this.exclusive(id, () => this.drive(saved));
  }

  /** Continues an unfinished operation forward from its last durable state (Retry). */
  async resume(id: string): Promise<OperationRecord> {
    return this.exclusive(id, async () => {
      const record = await this.mustLoad(id);
      return isTerminal(record.state) ? record : this.drive(record);
    });
  }

  /** Stops an operation that has not reached its commit, rolling it back. A committed one cannot be aborted. */
  async abort(id: string): Promise<OperationRecord> {
    return this.exclusive(id, async () => {
      const record = await this.mustLoad(id);
      if (isTerminal(record.state)) return record;
      if (!beforeCommit(record)) throw new TransferRefused("invalid_transfer_state", "This transfer has passed its commit and can only be finished.");
      return this.rollback(record, "aborted", { code: "aborted", message: "Stopped by the user." });
    });
  }

  async list(): Promise<OperationRecord[]> {
    return (await listRecords(this.vault)).records;
  }

  get(id: string): Promise<OperationRecord | undefined> {
    return loadRecord(this.vault, id);
  }

  /** Removes the record of a finished operation (for example after the user dealt with a pending cleanup). */
  async dismiss(id: string): Promise<void> {
    const record = await this.mustLoad(id);
    if (!isTerminal(record.state)) throw new TransferRefused("invalid_transfer_state", "An unfinished transfer cannot be dismissed.");
    await this.vault.removeRecord(`.thoth/operations/${id}.json`);
  }

  /**
   * Startup recovery (ADR-0006 §7). Rebuilds the index projections from the records, removes old completed
   * records, and settles every unfinished operation: before its commit it is rolled back (the staged server
   * transfer is aborted and our own unedited local files are removed); after it, it is finished.
   */
  async recover(): Promise<RecoveryReport> {
    const { records, invalid } = await listRecords(this.vault);
    const report: RecoveryReport = { completed: [], rolledBack: [], waiting: [], invalid };
    for (const r of records) await this.vault.projectOperation({ id: r.id, kind: r.kind, state: r.state, updatedAt: Date.parse(r.updatedAt) }).catch(() => undefined);
    await projectAllSync(this.vault).catch(() => undefined);
    const cutoff = this.now().getTime() - RECORD_RETENTION_DAYS * 86_400_000;
    for (const r of records) {
      if ((r.state === "done" || r.state === "aborted" || r.state === "failed") && Date.parse(r.updatedAt) < cutoff) await this.vault.removeRecord(`.thoth/operations/${r.id}.json`).catch(() => undefined);
    }
    for (const r of records) {
      if (isTerminal(r.state)) continue;
      try {
        const settled = await this.exclusive(r.id, () => this.settle(r));
        (settled.state === "aborted" || settled.state === "failed" ? report.rolledBack : report.completed).push(settled);
      } catch (error) {
        if (error instanceof Halt) throw error.reason;
        report.waiting.push(error instanceof TransferInterrupted ? error.record : r);
      }
    }
    return report;
  }

  private async settle(record: OperationRecord): Promise<OperationRecord> {
    if (!beforeCommit(record)) return this.drive(record);
    const interrupted = { code: "interrupted", message: "The app stopped before this transfer finished; it was rolled back and nothing changed at the destination." };
    // Before the server could know the operation, nothing remote can exist: roll back without the network.
    const mayBeKnown = record.serverKnown || (record.direction === "to_workspace" ? !before(record.state, "stage") : !before(record.state, "validate"));
    if (!mayBeKnown) return this.rollback(record, "aborted", interrupted, { remote: false });
    const access = this.access(record);
    const remote = await this.serverTransfer(access.client, record.id).catch((error: unknown) => {
      throw new TransferInterrupted(record, error);
    });
    if (remote && (remote.state === "done" || remote.state === "destination_committed_source_cleanup_pending")) return this.drive(record);
    return this.rollback(record, remote?.state === "failed" ? "failed" : "aborted", interrupted);
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
    const record = await loadRecord(this.vault, id);
    if (!record) throw new TransferRefused("not_found", "No such transfer.");
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
    const saved = await saveRecord(this.vault, record, this.now());
    this.options.onProgress?.(saved);
    await this.point(`saved:${point ?? saved.state}`);
    return saved;
  }

  private access(record: OperationRecord): ServerAccess {
    const access = this.options.server(record.server.id);
    if (!access) throw new Error("The server of this transfer is not available.");
    if (access.url !== record.server.url) throw new Error("The server of this transfer changed its address.");
    return access;
  }

  private async drive(start: OperationRecord): Promise<OperationRecord> {
    try {
      return await this.driveNow(start);
    } catch (error) {
      // A simulated crash surfaces as what the test threw, from any depth.
      if (error instanceof Halt) throw error.reason;
      throw error;
    }
  }

  private async driveNow(start: OperationRecord): Promise<OperationRecord> {
    let r = start;
    while (!isTerminal(r.state)) {
      try {
        r = await this.step(r);
      } catch (error) {
        if (error instanceof Halt) throw error;
        if (isRefusal(error) && beforeCommit(r)) {
          r = await this.rollback(r, "failed", { code: codeOf(error), message: messageOf(error) });
          continue; // a rollback can find the server committed after all, and continue forward
        }
        // A step may have saved progress before it failed: keep that, not the copy the step started from.
        const latest = (await loadRecord(this.vault, r.id)) ?? r;
        const kept = await this.save({ ...latest, error: { code: codeOf(error), message: messageOf(error) } }, `error:${latest.state}`);
        throw new TransferInterrupted(kept, error);
      }
    }
    return r;
  }

  private step(r: OperationRecord): Promise<OperationRecord> {
    if (r.direction === "to_workspace") {
      switch (r.state) {
        case "plan":
          return this.validateOut(r);
        case "validate":
          return this.uploadAttachments(r);
        case "stage":
          return this.stageOut(r);
        case "transfer":
          return this.verifyOut(r);
        case "verify":
          return this.commitOut(r);
        case "commit_destination":
          return r.mode === "copy" ? this.save({ ...r, state: "done", error: unverifiedError(r) }) : this.finalizeOut(r);
        case "finalize_source":
          return this.finalizeOut(r);
        default:
          return Promise.resolve(r);
      }
    }
    switch (r.state) {
      case "plan":
        return this.validateIn(r);
      case "validate":
        return this.stageIn(r);
      case "stage":
        return this.writeIn(r);
      case "transfer":
        return this.verifyIn(r);
      case "verify":
        return this.commitIn(r);
      case "commit_destination":
      case "finalize_source":
        return this.finalizeIn(r);
      default:
        return Promise.resolve(r);
    }
  }

  /** GET /transfers/{id}; undefined when the server never got it. */
  private async serverTransfer(client: WorkspaceClient, id: string): Promise<TransferResource | undefined> {
    try {
      return await client.getTransfer(id);
    } catch (error) {
      if (error instanceof ProblemError && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * Rolls an operation back (before its commit). The staged server transfer is aborted; a 409 there means the
   * server did commit (a lost response), and the operation continues forward instead. Our own local files
   * (Workspace → Private) are removed only while they still hold the bytes we wrote.
   */
  private async rollback(r: OperationRecord, state: "failed" | "aborted", error: { code: string; message: string }, options: { remote?: boolean } = {}): Promise<OperationRecord> {
    if (options.remote !== false && (r.serverKnown || !before(r.state, r.direction === "to_workspace" ? "stage" : "validate"))) {
      const access = this.options.server(r.server.id);
      if (access) {
        try {
          await this.point("before:abort");
          await access.client.abortTransfer(r.id);
          await this.point("after:abort");
        } catch (e) {
          if (e instanceof Halt) throw e;
          if (e instanceof ProblemError && e.code === "invalid_transfer_state") {
            const remote = await this.serverTransfer(access.client, r.id);
            if (remote && (remote.state === "done" || remote.state === "destination_committed_source_cleanup_pending")) {
              // Committed after all: never report it as rolled back. Continue from the verify step.
              return this.save({ ...r, state: r.direction === "to_workspace" ? "verify" : "commit_destination", serverKnown: true, error: null }, "rollback:committed");
            }
          } else if (!(e instanceof ProblemError && e.status === 404)) {
            // Unreachable: the staged transfer is invisible and expires at the server; record it and stop.
            error = { ...error, message: `${error.message} The server could not be told to discard its staged copy: ${messageOf(e)}` };
          }
        }
      }
    }
    const items = [...r.items];
    if (r.direction === "from_workspace") {
      for (const [i, item] of items.entries()) {
        if (item.folder) continue;
        if (!item.destPath || !item.destHash || (item.state !== "written" && item.state !== "verified" && item.state !== "staged" && item.state !== "planned")) continue;
        try {
          await this.vault.deleteFileAtomic(item.destPath, { expectedHash: item.destHash });
          items[i] = { ...item, state: "skipped" };
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          // Missing (never written) or edited since: leave it alone.
          items[i] = { ...item, state: e.actualHash === null ? "skipped" : item.state };
        }
      }
      // Then our folders, innermost first, and only while empty: anything put in them since is left alone.
      const folders = [...items.entries()].filter(([, item]) => item.folder && item.destPath && (item.state === "written" || item.state === "verified"));
      folders.sort(([, a], [, b]) => b.destPath!.length - a.destPath!.length);
      for (const [i, item] of folders) {
        try {
          await this.vault.removeEmptyFolder(item.destPath!);
          items[i] = { ...item, state: "skipped" };
        } catch {
          // not empty: keep it
        }
      }
    }
    return this.save({ ...r, items: items.map((i) => (i.state === "planned" || i.state === "staged" ? { ...i, state: "skipped" as const } : i)), state, failedAt: r.state, error }, `rollback:${state}`);
  }

  // ---------------------------------------------------- Private → Workspace

  private async validateOut(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    const caps = await access.client.getCapabilities();
    if (!hasCapability(caps, "transfers")) throw new TransferRefused("no_transfers", "This server does not accept transfers.");
    const ws = await this.workspaceOf(access, r.workspace.id);
    if (!ws) throw new TransferRefused("not_found", "The workspace no longer exists, or you are no longer a member.");
    if (!roleCan(ws.role, "write")) throw new TransferRefused("forbidden", "Your role in this workspace does not allow adding pages.");
    const limits = caps.limits ?? {};
    // Move keeps the page's ID unless this workspace has had a page with it (moved out and back before):
    // a server never reuses a page ID, even of a deleted page.
    const used = new Set((await loadSync(this.vault, access.url, r.workspace.id)).entries.filter((e) => e.kind === "page").map((e) => e.remoteId));
    const items: PageItem[] = [];
    for (const item of r.items) {
      if (item.folder) {
        items.push(item); // a folder page has no source file to adopt; its new ID was chosen in the plan
        continue;
      }
      let id: string;
      try {
        // ADR-0003: a page gets its stable ID before it takes part in a transfer. Adding it is the only change to a source.
        id = await this.vault.adoptPage(item.sourcePath);
      } catch (error) {
        if (error instanceof NotFoundError) throw new TransferRefused("source_missing", `${item.sourcePath} no longer exists.`);
        if (error instanceof NotEditableError || error instanceof FrontmatterError || error instanceof ConflictError) throw new TransferRefused("not_editable", `${item.sourcePath} cannot be given a stable ID: ${error.message}`);
        throw error;
      }
      const read = await this.vault.readPage(item.sourcePath);
      const size = new TextEncoder().encode(read.source).length;
      if (limits.maxMarkdownBytes !== undefined && size > limits.maxMarkdownBytes) throw new TransferRefused("payload_too_large", `${item.sourcePath} is larger than the server accepts.`);
      const keep = r.mode === "move" && !used.has(id);
      const destId = keep ? id : item.destId === "" || item.destId === id ? this.newId() : item.destId;
      items.push({ ...item, sourceId: id, sourceHash: read.hash, title: read.document.title.slice(0, 500) || "Untitled", destId });
    }
    const ids = items.map((i) => i.destId);
    if (new Set(ids).size !== ids.length) throw new TransferRefused("duplicate_id", "Two selected pages share one thoth_id; give one of them a new ID first.");
    const attachments = r.attachments.filter((a) => limits.maxAttachmentBytes === undefined || a.size <= limits.maxAttachmentBytes);
    return this.save({ ...r, items, attachments, state: "validate", error: null });
  }

  private async uploadAttachments(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    let record = r;
    for (const [i, a] of record.attachments.entries()) {
      if (a.state !== "planned") continue;
      const bytes = await this.vault.fs.readFile(a.sourcePath).catch(() => undefined);
      if (!bytes || sha256Hex(bytes) !== a.sourceHash) {
        // Changed or gone since the plan: it does not travel; links to it stay as written.
        record = await this.save(withAttachment(record, i, { ...a, state: "skipped", error: "source_changed" }), `skip:attachment:${i}`);
        continue;
      }
      await this.point(`before:upload:${i}`);
      const uploaded = await access.client.uploadAttachment(record.workspace.id, bytes, a.mimeType, { fileName: basename(a.sourcePath), idempotencyKey: a.uploadKey });
      await this.point(`after:upload:${i}`);
      if (uploaded.hash !== a.sourceHash || uploaded.size !== bytes.length) throw new TransferRefused("hash_mismatch", `The server stored different bytes for ${a.sourcePath}.`);
      record = await this.save(withAttachment(record, i, { ...a, destId: uploaded.id, destHash: uploaded.hash, state: "uploaded" }), `uploaded:${i}`);
    }
    return this.save({ ...record, state: "stage" });
  }

  /** The exact payload of every page: links rewritten through the mapping, `thoth_id` set to the destination ID. */
  private async buildOutbound(r: OperationRecord, access: ServerAccess): Promise<{ pages: { item: PageItem; markdown: string; hash: string; changed: boolean }[]; links: LinkSummary }> {
    const tree = await access.client.getTree(r.workspace.id);
    const includedPages = new Map(r.items.map((i) => [i.sourcePath, i.destId]));
    const includedAttachments = new Map<string, string | null>(r.attachments.filter((a) => a.state === "uploaded" && a.destId).map((a) => [a.sourcePath, a.destId]));
    const ctx = await this.outboundContext(access.url, r.workspace.id, tree.nodes.map((n) => n.id), includedPages, includedAttachments);
    const resolver = outboundResolver(ctx);
    const pages: { item: PageItem; markdown: string; hash: string; changed: boolean }[] = [];
    const classified: ClassifiedReference[] = [];
    for (const item of r.items) {
      if (item.folder) {
        const markdown = folderMarkdown(item.destId);
        pages.push({ item, markdown, hash: sha256Hex(markdown), changed: false });
        continue;
      }
      const read = await this.vault.readPage(item.sourcePath).catch(() => undefined);
      if (!read) throw new TransferRefused("source_missing", `${item.sourcePath} no longer exists.`);
      const refs = classifyOutbound(item.sourcePath, read.source, ctx, resolver);
      classified.push(...refs);
      let markdown = applyRewrites(read.source, refs, { labelBareWikilinks: true });
      if (read.document.thothId !== item.destId) markdown = updateFrontmatter(markdown, { thoth_id: item.destId });
      pages.push({ item, markdown, hash: sha256Hex(markdown), changed: read.hash !== item.sourceHash });
    }
    return { pages, links: summarize(classified) };
  }

  private async stageOut(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    const remote = await this.serverTransfer(access.client, r.id);
    let record = r;
    if (!remote) {
      const built = await this.buildOutbound(record, access);
      if (built.pages.some((p) => p.changed)) throw new TransferRefused("source_changed", "A page changed after the transfer was planned; nothing was sent. Start it again to send the new version.");
      const total = built.pages.reduce((n, p) => n + new TextEncoder().encode(p.markdown).length, 0);
      if (total > MAX_REQUEST_BYTES) throw new TransferRefused("payload_too_large", "These pages are too large to send together; select fewer.");
      // Durable before sending: the hash of exactly what the server receives.
      const items = record.items.map((item, i) => ({ ...item, destHash: built.pages[i]!.hash }));
      record = await this.save({ ...record, items, links: built.links }, "payloads");
      await this.point("before:create");
      await access.client.createTransfer(record.workspace.id, {
        operationId: record.id,
        direction: "to_workspace",
        mode: record.mode,
        pages: built.pages.map((p) => ({ sourceId: p.item.sourceId, pageId: p.item.destId, parentId: p.item.destParentId, title: p.item.title, markdown: p.markdown })),
        ...(record.attachments.some((a) => a.state === "uploaded") ? { attachmentIds: record.attachments.filter((a) => a.state === "uploaded").map((a) => a.destId!) } : {}),
      });
      await this.point("after:create");
    } else if (remote.state === "aborted" || remote.state === "failed") {
      throw new TransferRefused(remote.error?.code ?? "invalid_transfer_state", `The server reports this transfer as ${remote.state}.`);
    }
    return this.save({ ...record, serverKnown: true, state: "transfer" });
  }

  private async verifyOut(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    const remote = await this.serverTransfer(access.client, r.id);
    if (!remote) throw new TransferRefused("not_found", "The server no longer knows this transfer.");
    if (remote.state === "aborted" || remote.state === "failed") throw new TransferRefused(remote.error?.code ?? "invalid_transfer_state", `The server reports this transfer as ${remote.state}.`);
    const committed = remote.state === "done";
    const items = r.items.map((item) => {
      const echoed = remote.items.find((i) => i.pageId === item.destId);
      if (!echoed || echoed.sourceId !== item.sourceId || (!committed && echoed.state !== "staged")) throw new TransferRefused("echo_mismatch", `The server's copy of ${item.sourcePath} does not match the plan.`);
      return { ...item, state: "staged" as const };
    });
    if (remote.items.length !== r.items.length) throw new TransferRefused("echo_mismatch", "The server staged a different set of pages.");
    return this.save({ ...r, items, state: "verify" });
  }

  private async commitOut(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    await this.point("before:commit");
    const result = await access.client.commitTransfer(r.id);
    await this.point("after:commit");
    if (result.state !== "done") throw new TransferRefused(result.error?.code ?? "invalid_transfer_state", `The server reports this transfer as ${result.state}.`);
    // A verified destination commit: read every created revision back and compare it with what was sent.
    const items: PageItem[] = [];
    for (const item of r.items) {
      const revisionId = result.items.find((i) => i.pageId === item.destId)?.revisionId ?? null;
      let ok = false;
      if (revisionId) {
        try {
          const page = await access.client.getPage(r.workspace.id, item.destId, { revision: revisionId });
          ok = page.revision.contentHash === item.destHash && sha256Hex(page.markdown) === item.destHash;
        } catch (error) {
          if (!(error instanceof ProblemError)) throw error; // network: retry the step (commit replays unchanged)
        }
      }
      items.push(ok ? { ...item, destRevision: revisionId, state: "committed" } : { ...item, destRevision: revisionId, state: "failed", error: "hash_mismatch" });
    }
    const attachments = r.attachments.map((a) => (a.state === "uploaded" ? { ...a, state: "committed" as const } : a));
    const at = this.now().toISOString();
    const entries: SyncEntry[] = [
      ...items
        .filter((i) => i.state === "committed" && !i.folder)
        .map((i): SyncEntry => ({ kind: "page", localId: i.sourceId, remoteId: i.destId, localPath: i.sourcePath, localHash: i.sourceHash, remoteRevision: i.destRevision, remoteHash: i.destHash, direction: "to_workspace", mode: r.mode, operationId: r.id, at })),
      ...attachments
        .filter((a) => a.state === "committed" && a.destId)
        .map((a): SyncEntry => ({ kind: "attachment", localId: a.sourcePath, remoteId: a.destId!, localPath: a.sourcePath, localHash: a.sourceHash, remoteRevision: null, remoteHash: a.destHash, direction: "to_workspace", mode: r.mode, operationId: r.id, at })),
    ];
    await recordMappings(this.vault, r.server.url, r.workspace.id, entries);
    return this.save({ ...r, items, attachments, serverKnown: true, state: "commit_destination", error: null });
  }

  private async finalizeOut(r: OperationRecord): Promise<OperationRecord> {
    let record = r.state === "finalize_source" ? r : await this.save({ ...r, state: "finalize_source" });
    for (const [i, item] of record.items.entries()) {
      if (item.state === "failed") {
        // The destination could not be verified: the source stays (never deleted without a verified commit).
        record = await this.save(withItem(record, i, { ...item, state: "cleanup_pending", error: item.error ?? "hash_mismatch" }), `kept:${i}`);
        continue;
      }
      if (item.state !== "committed") continue;
      if (item.folder) continue; // a moved folder stays in the vault (it may be empty now); nothing is deleted for it
      let next: PageItem;
      await this.point(`before:delete:${i}`);
      try {
        await this.vault.deleteFileAtomic(item.sourcePath, { expectedHash: item.sourceHash! });
        next = { ...item, state: "source_deleted" };
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        if (error.actualHash === null) {
          // Gone from its path: deleted earlier (a crash after the delete) or moved by the user.
          const elsewhere = (await this.vault.listPages()).some((p) => p.id === item.sourceId);
          next = elsewhere ? { ...item, state: "cleanup_pending", error: "source_moved" } : { ...item, state: "source_deleted" };
        } else next = { ...item, state: "cleanup_pending", error: "source_changed" };
      }
      await this.point(`after:delete:${i}`);
      record = await this.save(withItem(record, i, next), `deleted:${i}`);
    }
    const pending = record.items.some((i) => i.state === "cleanup_pending");
    return this.save({ ...record, state: pending ? "destination_committed_source_cleanup_pending" : "done", error: null });
  }

  // ---------------------------------------------------- Workspace → Private

  private async validateIn(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    const caps = await access.client.getCapabilities();
    if (!hasCapability(caps, "transfers")) throw new TransferRefused("no_transfers", "This server does not accept transfers.");
    const ws = await this.workspaceOf(access, r.workspace.id);
    if (!ws) throw new TransferRefused("not_found", "The workspace no longer exists, or you are no longer a member.");
    if (ws.exportRestricted) throw new TransferRefused("export_restricted", "This workspace does not allow copying or moving its pages out.");
    if (r.mode === "move" && !roleCan(ws.role, "write")) throw new TransferRefused("forbidden", "Your role in this workspace does not allow moving pages out.");
    return this.save({ ...r, state: "validate", error: null });
  }

  private async stageIn(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    let remote = await this.serverTransfer(access.client, r.id);
    if (!remote) {
      await this.point("before:create");
      remote = await access.client.createTransfer(r.workspace.id, { operationId: r.id, direction: "from_workspace", mode: r.mode, pages: r.items.map((i) => ({ pageId: i.sourceId })) });
      await this.point("after:create");
    }
    if (remote.state === "aborted" || remote.state === "failed") throw new TransferRefused(remote.error?.code ?? "invalid_transfer_state", `The server reports this transfer as ${remote.state}.`);
    const items = r.items.map((item) => {
      const pinned = remote.items.find((i) => i.pageId === item.sourceId);
      if (!pinned?.revisionId) throw new TransferRefused("echo_mismatch", `The server did not pin ${item.title}.`);
      return { ...item, sourceRevision: pinned.revisionId, state: "staged" as const };
    });
    return this.save({ ...r, items, serverKnown: true, state: "stage" });
  }

  private async writeIn(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    let record = r;
    const sync = await loadSync(this.vault, r.server.url, r.workspace.id);
    // Every destination path is chosen and recorded before anything is written, so links between the pages
    // can name each other and a crash never makes a page land twice.
    if (record.items.some((i) => i.destPath === null)) record = await this.save({ ...record, items: await this.planPaths(record, sync) }, "paths");
    // Folder pages become vault folders first (ADR-0016 rule 3); they have no file of their own.
    for (let i = 0; i < record.items.length; i++) {
      const item = record.items[i]!;
      if (!item.folder || item.state !== "staged") continue;
      const page = await access.client.getPage(record.workspace.id, item.sourceId, { revision: item.sourceRevision! });
      if (sha256Hex(page.markdown) !== page.revision.contentHash || page.revision.id !== item.sourceRevision) throw new TransferRefused("hash_mismatch", `The server sent different content for ${item.title}.`);
      await this.point(`before:mkdir:${i}`);
      try {
        await this.vault.createFolder(item.destPath!);
      } catch (error) {
        // Our own folder from before a crash (its path was recorded first) is accepted as it is.
        if (!(error instanceof ConflictError) || (await this.vault.fs.stat(item.destPath!))?.kind !== "directory") throw error;
      }
      await this.point(`after:mkdir:${i}`);
      record = await this.save(withItem(record, i, { ...item, sourceHash: page.revision.contentHash, destHash: null, state: "written" }), `written:${i}`);
    }
    const files = (items: readonly PageItem[]) => items.filter((x) => !x.folder);
    const classified: ClassifiedReference[] = [];
    for (let i = 0; i < record.items.length; i++) {
      const item = record.items[i]!;
      if (item.state !== "staged" || item.folder) continue;
      const page = await access.client.getPage(record.workspace.id, item.sourceId, { revision: item.sourceRevision! });
      const hash = sha256Hex(page.markdown);
      if (hash !== page.revision.contentHash || page.revision.id !== item.sourceRevision) throw new TransferRefused("hash_mismatch", `The server sent different content for ${item.title}.`);
      let target: PageItem = { ...item, sourceHash: hash };
      // Where it goes: a free path, our own earlier write, or (the same page edited here) a conflict copy.
      const placed = await this.placeInbound(record, target);
      target = placed;
      const now = files(record.items.map((x, j) => (j === i ? target : x)));
      const ctx = await this.inboundContext(sync, new Map(now.map((x) => [x.sourceId, x.destPath!])));
      const resolver = await this.localResolver(now.map((x) => x.destPath!));
      const refs = classifyInbound(target.destPath!, page.markdown, ctx, resolver);
      classified.push(...refs);
      let content = compactInbound(applyRewrites(page.markdown, refs, { labelBareWikilinks: false }), target.destPath!, resolver);
      content = withThothId(content, target.destId);
      const destHash = sha256Hex(content);
      const existing = await this.hashAt(target.destPath!);
      if (existing === null || existing !== (item.destHash ?? destHash)) {
        record = await this.save(withItem(record, i, { ...target, destHash }), `planned:${i}`);
        await this.point(`before:write:${i}`);
        await this.vault.writePage(target.destPath!, content, { expectedHash: null });
        await this.point(`after:write:${i}`);
      }
      // `existing === recorded destHash`: written before a crash, left as it is.
      const writtenHash = existing !== null && existing === item.destHash ? item.destHash : destHash;
      record = await this.save(withItem(record, i, { ...target, destHash: writtenHash, state: "written" }), `written:${i}`);
    }
    const links = classified.length > 0 ? summarize(classified) : record.links;
    return this.save({ ...record, links, state: "transfer" });
  }

  /**
   * Chooses the vault path of every item: back where a moved page came from if that path is free, else
   * `<folder>/<title>.md`. A folder page becomes the vault folder `<folder>/<title>`, and the selected pages
   * under it go inside it (ADR-0016 rule 3).
   */
  private async planPaths(r: OperationRecord, sync: SyncRecord): Promise<PageItem[]> {
    const taken = new Set<string>();
    for (const p of await this.vault.listPages()) taken.add(collisionKey(p.path));
    for (const a of await this.vault.listAttachments()) taken.add(collisionKey(a.path));
    for (const item of r.items) if (item.destPath !== null) taken.add(collisionKey(item.destPath));
    const free = async (path: string) => !taken.has(collisionKey(path)) && !(await this.vault.fs.stat(path));
    const out = new Map<string, PageItem>();
    const place = async (item: PageItem, depth = 0): Promise<PageItem> => {
      const done = out.get(item.sourceId);
      if (done) return done;
      if (item.destPath !== null) {
        out.set(item.sourceId, item);
        return item;
      }
      const parent = depth < 100 && item.destParentId !== null ? r.items.find((x) => x.folder && x.sourceId === item.destParentId) : undefined;
      const dir = parent ? (await place(parent, depth + 1)).destPath! : r.destination.folder;
      let path: string | undefined;
      if (item.folder) path = await this.freeFolderPath(joinVaultPath(...pathParts(dir), folderNameForTitle(item.title)), free);
      else {
        const origin = parent ? undefined : sync.entries.find((e) => e.kind === "page" && e.remoteId === item.sourceId && e.direction === "to_workspace" && e.mode === "move");
        path = origin && (await free(origin.localPath)) ? origin.localPath : undefined;
        if (!path) path = await this.freePath(joinVaultPath(...pathParts(dir), fileNameForTitle(item.title)), free);
      }
      taken.add(collisionKey(path));
      const placed = { ...item, destPath: path };
      out.set(item.sourceId, placed);
      return placed;
    };
    const result: PageItem[] = [];
    for (const item of r.items) result.push(await place(item));
    return result;
  }

  private async freeFolderPath(wanted: string, free: (path: string) => Promise<boolean>): Promise<string> {
    if (await free(wanted)) return wanted;
    for (let n = 2; n < 1000; n++) if (await free(`${wanted} ${n}`)) return `${wanted} ${n}`;
    throw new TransferRefused("no_free_name", `No free folder name for ${wanted}.`);
  }

  private async freePath(wanted: string, free: (path: string) => Promise<boolean>): Promise<string> {
    if (await free(wanted)) return wanted;
    const dir = dirname(wanted);
    const stem = basename(wanted).replace(/\.md$/i, "");
    for (let n = 2; n < 1000; n++) {
      const candidate = dir ? `${dir}/${stem} ${n}.md` : `${stem} ${n}.md`;
      if (await free(candidate)) return candidate;
    }
    throw new TransferRefused("no_free_name", `No free file name for ${wanted}.`);
  }

  /**
   * Re-checks the planned path just before writing. Something new at the path that is not our own write
   * moves the page to the next free name; the same page (same `thoth_id`) already in the vault with other
   * content gets a conflict copy with a new ID instead (ADR-0005: keep both, never overwrite).
   */
  private async placeInbound(r: OperationRecord, item: PageItem): Promise<PageItem> {
    const others = new Set(r.items.filter((x) => x !== item && x.destPath).map((x) => collisionKey(x.destPath!)));
    const pages = await this.vault.listPages();
    const sameId = pages.find((p) => p.id === item.destId && p.path !== item.destPath);
    const existing = await this.hashAt(item.destPath!);
    const ours = existing !== null && existing === item.destHash;
    if (ours) return item;
    const free = async (path: string) => !others.has(collisionKey(path)) && !(await this.vault.fs.stat(path));
    const atPath = existing === null ? undefined : pages.find((p) => p.path === item.destPath);
    if (sameId || atPath?.id === item.destId) {
      const stamp = conflictStamp(this.now());
      const base = item.destPath!.replace(/\.md$/i, "");
      const path = await this.freePath(`${base} (conflict ${stamp}).md`, free);
      return { ...item, destPath: path, destId: this.newId(), conflictCopy: true };
    }
    if (existing !== null) return { ...item, destPath: await this.freePath(item.destPath!, free) };
    return item;
  }

  private async verifyIn(r: OperationRecord): Promise<OperationRecord> {
    const items = await Promise.all(
      r.items.map(async (item) => {
        if (item.state !== "written") return item;
        if (item.folder) {
          if ((await this.vault.fs.stat(item.destPath!))?.kind !== "directory") throw new TransferRefused("hash_mismatch", `The folder ${item.destPath} is gone.`);
          return { ...item, state: "verified" as const };
        }
        const actual = await this.hashAt(item.destPath!);
        if (actual !== item.destHash) throw new TransferRefused("hash_mismatch", `${item.destPath} changed while it was being written.`);
        return { ...item, state: "verified" as const };
      }),
    );
    return this.save({ ...r, items, state: "verify" });
  }

  private async commitIn(r: OperationRecord): Promise<OperationRecord> {
    const at = this.now().toISOString();
    const entries = r.items
      .filter((i) => i.state === "verified" && !i.folder)
      .map((i): SyncEntry => ({ kind: "page", localId: i.destId, remoteId: i.sourceId, localPath: i.destPath!, localHash: i.destHash, remoteRevision: i.sourceRevision, remoteHash: i.sourceHash, direction: "from_workspace", mode: r.mode, operationId: r.id, at }));
    await recordMappings(this.vault, r.server.url, r.workspace.id, entries);
    return this.save({ ...r, state: "commit_destination" });
  }

  private async finalizeIn(r: OperationRecord): Promise<OperationRecord> {
    const access = this.access(r);
    const record = r.state === "finalize_source" ? r : await this.save({ ...r, state: "finalize_source" });
    const verified = record.items.filter((i) => i.state === "verified" || i.state === "committed" || i.state === "source_deleted" || i.state === "cleanup_pending").map((i) => ({ pageId: i.sourceId, revisionId: i.sourceRevision!, contentHash: i.sourceHash! }));
    let result: TransferResource;
    try {
      await this.point("before:commit");
      result = await access.client.commitTransfer(record.id, { verified });
      await this.point("after:commit");
    } catch (error) {
      if (error instanceof Halt || !isRefusal(error)) throw error;
      // The pages are safely here; the server would not finalize. A move keeps its source: say so.
      const items = record.items.map((i) => ({ ...i, state: record.mode === "move" ? ("cleanup_pending" as const) : ("committed" as const), error: codeOf(error) }));
      return this.save({ ...record, items, state: record.mode === "move" ? "destination_committed_source_cleanup_pending" : "done", error: { code: codeOf(error), message: messageOf(error) } });
    }
    const items = record.items.map((item) => {
      const remote = result.items.find((i) => i.pageId === item.sourceId);
      if (remote?.state === "failed") return { ...item, state: "cleanup_pending" as const, error: remote.error ?? "revision_conflict" };
      return { ...item, state: record.mode === "move" ? ("source_deleted" as const) : ("committed" as const) };
    });
    const state = result.state === "destination_committed_source_cleanup_pending" || items.some((i) => i.state === "cleanup_pending") ? "destination_committed_source_cleanup_pending" : "done";
    return this.save({ ...record, items, state, error: null });
  }

  // ---------------------------------------------------------------- context

  private async outboundContext(serverUrl: string, workspaceId: string, remotePages: readonly string[], includedPages: Map<string, string>, includedAttachments: Map<string, string | null>): Promise<OutboundContext> {
    const pages = await this.vault.listPages();
    const attachments = await this.vault.listAttachments();
    const sync = await loadSync(this.vault, serverUrl, workspaceId);
    const present = new Set(remotePages);
    const hashOf = new Map(attachments.map((a) => [a.path, a.hash]));
    const mappedPages = new Map<string, string>();
    const mappedAttachments = new Map<string, string>();
    for (const e of sync.entries) {
      if (e.kind === "page" && present.has(e.remoteId)) mappedPages.set(e.localId, e.remoteId);
      // An attachment counts as already there only while the local bytes are the ones uploaded.
      if (e.kind === "attachment" && hashOf.get(e.localPath) === e.localHash) mappedAttachments.set(e.localPath, e.remoteId);
    }
    return {
      files: [...pages.map((p) => p.path), ...attachments.map((a) => a.path)],
      pages: pages.map((p) => ({ path: p.path, aliases: p.aliases, thothId: isStableId(p.id) ? p.id : null })),
      includedPages,
      includedAttachments,
      mappedPages,
      mappedAttachments,
    };
  }

  private async inboundContext(sync: SyncRecord, includedPages: Map<string, string>): Promise<InboundContext> {
    const pages = await this.vault.listPages();
    const attachments = await this.vault.listAttachments();
    const pathOfId = new Map(pages.map((p) => [p.id, p.path]));
    const hashOf = new Map(attachments.map((a) => [a.path, a.hash]));
    const knownPages = new Map<string, string>();
    const knownAttachments = new Map<string, string>();
    for (const e of sync.entries) {
      if (e.kind === "page") {
        const path = pathOfId.get(e.localId); // follows renames: the ID is stable, the path is not
        if (path) knownPages.set(e.remoteId, path);
      } else if (hashOf.get(e.localPath) === e.remoteHash) knownAttachments.set(e.remoteId, e.localPath);
    }
    return { includedPages, knownPages, knownAttachments };
  }

  private async localResolver(planned: readonly string[]): Promise<LinkResolver> {
    const pages = await this.vault.listPages();
    const attachments = await this.vault.listAttachments();
    const files = [...new Set([...pages.map((p) => p.path), ...attachments.map((a) => a.path), ...planned])];
    return new LinkResolver(files, pages.map((p) => ({ path: p.path, aliases: p.aliases })));
  }

  private async hashAt(path: string): Promise<string | null> {
    const stat = await this.vault.fs.stat(path);
    if (!stat || stat.kind !== "file") return null;
    return sha256Hex(await this.vault.fs.readFile(path));
  }
}

const PLACEHOLDER_ID = "00000000-0000-7000-8000-000000000000";

function summaryOf(ws: Workspace): WorkspaceSummary {
  return { id: ws.id, name: ws.name, role: ws.role, exportRestricted: ws.exportRestricted, memberCount: ws.memberCount, ...(ws.members ? { members: ws.members } : {}) };
}

function addLinkWarnings(links: LinkSummary, warnings: Warning[], extra: { attachmentsStay?: number } = {}): void {
  if (links.counts.unresolved > 0) warnings.push({ code: "unresolved_links", count: links.counts.unresolved });
  if (links.counts.left_at_source > 0) warnings.push({ code: "left_at_source", count: links.counts.left_at_source });
  if (extra.attachmentsStay) warnings.push({ code: "attachments_stay_in_workspace", count: extra.attachmentsStay });
}

function countAttachmentsLeft(refs: readonly ClassifiedReference[]): number {
  return refs.filter((r) => r.class === "left_at_source" && r.reference.target.startsWith("thoth:attachment/")).length;
}

/** A copy whose pages could not all be verified at the destination: the sources are intact, but say so. */
function unverifiedError(r: OperationRecord): OperationRecord["error"] {
  const failed = r.items.filter((i) => i.state === "failed").length;
  return failed === 0 ? null : { code: "hash_mismatch", message: `${failed} page(s) could not be verified at the destination; the originals are unchanged.` };
}

function withItem(r: OperationRecord, index: number, item: PageItem): OperationRecord {
  return { ...r, items: r.items.map((x, i) => (i === index ? item : x)) };
}

function withAttachment(r: OperationRecord, index: number, item: AttachmentItem): OperationRecord {
  return { ...r, attachments: r.attachments.map((x, i) => (i === index ? item : x)) };
}

/** Sets `thoth_id`, leaving the bytes alone when it is already right. Malformed frontmatter is written as is. */
function withThothId(markdown: string, id: string): string {
  const current = /^﻿?---\r?\n[\s\S]*?^thoth_id:[ \t]*["']?([0-9a-f-]{36})["']?[ \t]*$/m.exec(markdown)?.[1];
  if (current === id) return markdown;
  try {
    return updateFrontmatter(markdown, { thoth_id: id });
  } catch (error) {
    if (error instanceof FrontmatterError) return markdown;
    throw error;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
function conflictStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function normalizeFolder(folder: string): string {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  const normalized = normalizeVaultPath(trimmed);
  if (collisionKey(normalized.split("/")[0]!) === ".thoth") throw new Error("reserved");
  return normalized;
}

const pathParts = (folder: string): string[] => (folder === "" ? [] : [folder]);
