/**
 * Typed client for the Thoth workspace protocol (docs/protocol/README.md).
 *
 * It owns no transport: every request goes through an injected `send`, so the
 * desktop app routes it through the Rust host (which adds credentials) and the
 * web client (Phase 2c) through `fetch`. Responses are validated with the
 * protocol schemas; errors become `ProblemError` (or `RevisionConflict`,
 * `QuotaExceeded`).
 */
import type { z } from "zod";
import { newStableId } from "@thoth/domain";
import {
  API_BASE_PATH,
  AttachmentResourceSchema,
  CapabilitiesSchema,
  ChangesResponseSchema,
  MeSchema,
  PageResourceSchema,
  SearchResponseSchema,
  TransferResourceSchema,
  TreePageSchema,
  WorkspaceListSchema,
  formatEtag,
  type AttachmentResource,
  type Capabilities,
  type ChangesResponse,
  type Me,
  type PageResource,
  type PageWrite,
  type SearchRequest,
  type SearchResponse,
  type TransferCommitRequest,
  type TransferCreateRequest,
  type TransferResource,
  type TreeNode,
  type Workspace,
} from "@thoth/workspace-protocol";
import { ProtocolError, problemFromResponse } from "./errors.ts";

export interface SendRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Full path including `/api/v1`, no query string. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface SendResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string;
}

export type Send = (request: SendRequest) => Promise<SendResponse>;

export interface WholeTree {
  nodes: TreeNode[];
  /** Follow `listChanges` from here to stay current. */
  changeCursor: string;
}

export interface WorkspaceClientOptions {
  /** Stable-id factory for new pages; UUIDv7 by default. */
  newPageId?: () => string;
  /** Safety stop for paginated reads that never end. */
  maxPages?: number;
}

const encoder = new TextEncoder();
const JSON_HEADERS = { "content-type": "application/json" };

const seg = (value: string): string => encodeURIComponent(value);

export class WorkspaceClient {
  private readonly send: Send;
  private readonly newPageId: () => string;
  private readonly maxPages: number;

  constructor(send: Send, options: WorkspaceClientOptions = {}) {
    this.send = send;
    this.newPageId = options.newPageId ?? (() => newStableId());
    this.maxPages = options.maxPages ?? 1000;
  }

  private async request<S extends z.ZodType>(schema: S | null, init: SendRequest & { ok?: readonly number[] }): Promise<{ data: z.infer<S>; response: SendResponse }> {
    const { ok = [200], ...request } = init;
    const response = await this.send({ ...request, path: `${API_BASE_PATH}${request.path}` });
    if (!ok.includes(response.status)) throw problemFromResponse(response.status, response.body);
    if (schema === null) return { data: undefined as z.infer<S>, response };
    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch {
      throw new ProtocolError(`The server sent a response that is not JSON (HTTP ${response.status}).`, response.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ProtocolError(`The server sent a response this app does not understand (${init.method} ${init.path}).`, response.status);
    return { data: parsed.data as z.infer<S>, response };
  }

  async getCapabilities(): Promise<Capabilities> {
    return (await this.request(CapabilitiesSchema, { method: "GET", path: "/capabilities" })).data;
  }

  async getMe(): Promise<Me> {
    return (await this.request(MeSchema, { method: "GET", path: "/me" })).data;
  }

  /** Every workspace the principal belongs to (follows pagination). */
  async listWorkspaces(): Promise<Workspace[]> {
    const out: Workspace[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < this.maxPages; i++) {
      const query: Record<string, string> = cursor === null ? {} : { cursor };
      const { data } = await this.request(WorkspaceListSchema, { method: "GET", path: "/workspaces", query });
      out.push(...data.items);
      if (data.nextCursor === null) return out;
      cursor = data.nextCursor;
    }
    throw new ProtocolError("The server's workspace list never ended.", 200);
  }

  /** Every tree node of a workspace, plus the baseline change cursor of the traversal. */
  async getTree(workspaceId: string): Promise<WholeTree> {
    const nodes: TreeNode[] = [];
    let cursor: string | null = null;
    let changeCursor: string | undefined;
    for (let i = 0; i < this.maxPages; i++) {
      const query: Record<string, string> = cursor === null ? {} : { cursor };
      const { data } = await this.request(TreePageSchema, { method: "GET", path: `/workspaces/${seg(workspaceId)}/tree`, query });
      nodes.push(...data.items);
      changeCursor ??= data.changeCursor;
      if (data.nextCursor === null) return { nodes, changeCursor };
      cursor = data.nextCursor;
    }
    throw new ProtocolError("The server's page tree never ended.", 200);
  }

  async getPage(workspaceId: string, pageId: string, options: { revision?: string } = {}): Promise<PageResource> {
    const query: Record<string, string> = options.revision === undefined ? {} : { revision: options.revision };
    return (await this.request(PageResourceSchema, { method: "GET", path: `/workspaces/${seg(workspaceId)}/pages/${seg(pageId)}`, query })).data;
  }

  /**
   * Conditional write. `expected` is the revision id the edit was based on (`If-Match`), or `null` to create
   * (`If-None-Match: *`). A stale write throws `RevisionConflict` and writes nothing.
   */
  async putPage(workspaceId: string, pageId: string, write: PageWrite, expected: string | null, options: { idempotencyKey?: string } = {}): Promise<PageResource> {
    const headers: Record<string, string> = { ...JSON_HEADERS, ...(expected === null ? { "if-none-match": "*" } : { "if-match": formatEtag(expected) }) };
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    const { data } = await this.request(PageResourceSchema, {
      method: "PUT",
      path: `/workspaces/${seg(workspaceId)}/pages/${seg(pageId)}`,
      headers,
      body: encoder.encode(JSON.stringify(write)),
      ok: expected === null ? [201, 200] : [200],
    });
    return data;
  }

  /** Creates a page with a fresh UUIDv7 id. */
  createPage(workspaceId: string, write: PageWrite, options: { idempotencyKey?: string } = {}): Promise<PageResource> {
    return this.putPage(workspaceId, this.newPageId(), write, null, options);
  }

  async deletePage(workspaceId: string, pageId: string, expected: string): Promise<void> {
    await this.request(null, { method: "DELETE", path: `/workspaces/${seg(workspaceId)}/pages/${seg(pageId)}`, headers: { "if-match": formatEtag(expected) }, ok: [204] });
  }

  /** One page of the change feed after `cursor` (from the start of retained history when omitted). */
  async listChanges(workspaceId: string, cursor?: string, options: { limit?: number } = {}): Promise<ChangesResponse> {
    const query: Record<string, string> = {};
    if (cursor !== undefined) query["cursor"] = cursor;
    if (options.limit !== undefined) query["limit"] = String(options.limit);
    return (await this.request(ChangesResponseSchema, { method: "GET", path: `/workspaces/${seg(workspaceId)}/changes`, query })).data;
  }

  async search(workspaceId: string, request: SearchRequest): Promise<SearchResponse> {
    return (await this.request(SearchResponseSchema, { method: "POST", path: `/workspaces/${seg(workspaceId)}/search`, headers: JSON_HEADERS, body: encoder.encode(JSON.stringify(request)) })).data;
  }

  /**
   * Uploads attachment bytes (capability `attachments`). With an `idempotencyKey`, a retry after a lost
   * response replays the first upload instead of storing a second attachment.
   */
  async uploadAttachment(workspaceId: string, bytes: Uint8Array, mimeType: string, options: { fileName?: string; idempotencyKey?: string } = {}): Promise<AttachmentResource> {
    const headers: Record<string, string> = { "content-type": mimeType };
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    const query: Record<string, string> = options.fileName === undefined ? {} : { fileName: options.fileName };
    return (await this.request(AttachmentResourceSchema, { method: "POST", path: `/workspaces/${seg(workspaceId)}/attachments`, query, headers, body: bytes, ok: [201] })).data;
  }

  /**
   * Registers and stages a transfer (capability `transfers`). The `Idempotency-Key` is the plan's
   * `operationId` (ADR-0006), so re-sending the same plan after a crash returns the original transfer.
   */
  async createTransfer(workspaceId: string, plan: TransferCreateRequest): Promise<TransferResource> {
    return (
      await this.request(TransferResourceSchema, {
        method: "POST",
        path: `/workspaces/${seg(workspaceId)}/transfers`,
        headers: { ...JSON_HEADERS, "idempotency-key": plan.operationId },
        body: encoder.encode(JSON.stringify(plan)),
        ok: [201],
      })
    ).data;
  }

  async getTransfer(operationId: string): Promise<TransferResource> {
    return (await this.request(TransferResourceSchema, { method: "GET", path: `/transfers/${seg(operationId)}` })).data;
  }

  /** Commits a transfer; committing a finished one returns it unchanged. `verified` is required to finalize a from_workspace move. */
  async commitTransfer(operationId: string, body: TransferCommitRequest = {}): Promise<TransferResource> {
    return (await this.request(TransferResourceSchema, { method: "POST", path: `/transfers/${seg(operationId)}/commit`, headers: JSON_HEADERS, body: encoder.encode(JSON.stringify(body)) })).data;
  }

  /** Discards staged items. Repeating it is harmless; a committed transfer answers 409 `invalid_transfer_state`. */
  async abortTransfer(operationId: string): Promise<TransferResource> {
    return (await this.request(TransferResourceSchema, { method: "POST", path: `/transfers/${seg(operationId)}/abort` })).data;
  }
}
