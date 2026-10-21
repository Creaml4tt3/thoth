import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { ChangesResponseSchema, type Capabilities, type ChangeEntry } from "@thoth/workspace-protocol";
import type { ApiResponse, Client } from "./http.ts";
import type { CheckGroup, ConformanceOptions } from "./types.ts";

/** Thrown by a check to report a failed assertion. */
export class CheckFailure extends Error {}
/** Thrown by a check whose prerequisites are not met. */
export class CheckSkip extends Error {}

export function fail(message: string): never {
  throw new CheckFailure(message);
}

export function skip(message: string): never {
  throw new CheckSkip(message);
}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const deepEqual = isDeepStrictEqual;

export interface PrimaryPage {
  id: string;
  /** Markdown of each revision we wrote, keyed by revision ID. */
  markdownByRevision: Map<string, string>;
  /** Revision objects exactly as returned by the writes, for the immutability check. */
  revisionSnapshots: Map<string, unknown>;
  /** The revision created first. */
  rev1: string;
  /** The revision created by the If-Match update, once known. */
  rev2: string | null;
}

export interface Context {
  client: Client;
  options: ConformanceOptions;
  /** Random per-run label used in titles and content. */
  runId: string;
  capabilities: Capabilities | null;
  workspaceId: string | null;
  /** Change cursor taken before any write of this run. */
  baselineCursor: string | null;
  primary: PrimaryPage | null;
  /** Page IDs created by this run; removed by the cleanup check. */
  createdPageIds: Set<string>;
  /** Transfer operation that was committed, for the abort-after-commit check. */
  committedTransferId: string | null;
}

export interface Check {
  id: string;
  title: string;
  capability: CheckGroup;
  run(ctx: Context): Promise<string | void>;
}

export function requireWorkspace(ctx: Context): string {
  return ctx.workspaceId ?? skip("no workspace where the principal is owner or editor was found (see core.workspaces.list)");
}

export function requirePrimary(ctx: Context): PrimaryPage {
  return ctx.primary ?? skip("prerequisite core.pages.create-returns-etag did not pass");
}

/** Asserts status and contract conformance of a response. */
export function expectResponse(res: ApiResponse, status: number, what: string): void {
  const problems: string[] = [];
  if (res.status !== status) {
    const code = res.body && typeof res.body === "object" && "code" in res.body ? ` (code ${String((res.body as { code: unknown }).code)})` : "";
    problems.push(`expected HTTP ${status}, got ${res.status}${code}`);
  }
  problems.push(...res.issues);
  if (problems.length) fail(`${what}: ${problems.join("; ")}`);
}

/** Asserts an error response: status, problem+json, and the problem `code`. */
export function expectProblem(res: ApiResponse, status: number, code: string, what: string): void {
  expectResponse(res, status, what);
  const got = (res.body as { code?: unknown } | undefined)?.code;
  if (got !== code) fail(`${what}: expected code ${code}, got ${String(got)}`);
}

export function parsed<T extends z.ZodType>(schema: T, res: ApiResponse, what: string): z.infer<T> {
  const result = schema.safeParse(res.body);
  if (!result.success) fail(`${what}: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return result.data;
}

export function etagOf(res: ApiResponse): string | null {
  return res.headers.get("etag");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Follows `hasMore`/`cursor` of the change feed from `cursor`. Returns every entry in feed order. */
export async function readFeed(ctx: Context, workspaceId: string, from: string | null, limit: number | undefined, label: string): Promise<{ entries: ChangeEntry[]; requests: number; lastCursor: string | null; lastHasMore: boolean }> {
  const entries: ChangeEntry[] = [];
  let cursor = from;
  let requests = 0;
  let lastHasMore = true;
  const MAX_REQUESTS = 1000;
  while (lastHasMore) {
    if (requests >= MAX_REQUESTS) skip(`${label}: change feed did not terminate within ${MAX_REQUESTS} requests`);
    const res = await ctx.client.call("listWorkspaceChanges", { params: { workspaceId }, query: { cursor: cursor ?? undefined, limit } });
    expectResponse(res, 200, `${label} (request ${requests + 1})`);
    const page = parsed(ChangesResponseSchema, res, label);
    requests++;
    entries.push(...page.entries);
    if (limit !== undefined && page.entries.length > limit) fail(`${label}: server returned ${page.entries.length} entries for limit=${limit}`);
    if (page.hasMore && page.entries.length === 0 && page.cursor === cursor) fail(`${label}: hasMore is true but the cursor did not advance`);
    cursor = page.cursor;
    lastHasMore = page.hasMore;
  }
  return { entries, requests, lastCursor: cursor, lastHasMore };
}
