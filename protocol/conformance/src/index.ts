import { randomBytes } from "node:crypto";
import { PageResourceSchema, parseEtag } from "@thoth/workspace-protocol";
import { attachmentChecks, eventChecks, pageKindChecks, pageOrderChecks, searchChecks, transferChecks } from "./checks-capabilities.ts";
import { coreChecks } from "./checks-core.ts";
import { shareChecks } from "./checks-share.ts";
import { inviteChecks, memberChecks } from "./checks-members.ts";
import { workspaceChecks } from "./checks-workspaces.ts";
import { feedbackChecks } from "./checks-feedback.ts";
import { createClient } from "./http.ts";
import { CheckFailure, CheckSkip, type Check, type Context } from "./support.ts";
import type { CheckGroup, CheckResult, ConformanceGroup, ConformanceOptions, ConformanceReport } from "./types.ts";

export type { CheckGroup, CheckResult, CheckStatus, ConformanceGroup, ConformanceOptions, ConformanceReport, ConformanceSummary } from "./types.ts";

/** Runs after the capability checks: every response seen during the run must have conformed to the contract. */
const responseContractCheck: Check = {
  id: "core.schemas.all-responses-valid",
  title: "Every response body of the run validates against the protocol schemas and error registry",
  capability: "core",
  async run(ctx) {
    const violations = ctx.client.violations;
    if (ctx.client.stats.responses === 0) throw new CheckFailure("no HTTP response was received, so nothing could be validated");
    if (violations.length) {
      const lines = violations.slice(0, 10).map((v) => `${v.operation} -> ${v.status}: ${v.issues.join("; ")}`);
      throw new CheckFailure(`${violations.length} response(s) violated the contract. ${lines.join(" | ")}${violations.length > 10 ? " | ..." : ""}`);
    }
    return `all ${ctx.client.stats.responses} responses of the run conform`;
  },
};

const cleanupCheck: Check = {
  id: "core.cleanup.delete-created-pages",
  title: "Pages created by this run can be deleted with If-Match",
  capability: "core",
  async run(ctx) {
    if (!ctx.workspaceId) throw new CheckSkip("no workspace was selected");
    let deleted = 0;
    const failures: string[] = [];
    for (const pageId of ctx.createdPageIds) {
      const get = await ctx.client.call("getPage", { params: { workspaceId: ctx.workspaceId, pageId } });
      if (get.status === 404) continue;
      const etag = parseEtag(get.headers.get("etag"));
      if (get.status !== 200 || !etag || !PageResourceSchema.safeParse(get.body).success) {
        failures.push(`${pageId}: GET returned ${get.status}`);
        continue;
      }
      const del = await ctx.client.call("deletePage", { params: { workspaceId: ctx.workspaceId, pageId }, headers: { "if-match": `"${etag}"` } });
      if (del.status === 204) deleted++;
      else failures.push(`${pageId}: DELETE returned ${del.status}`);
    }
    if (failures.length) throw new CheckFailure(`could not delete ${failures.length} page(s) created by this run: ${failures.join("; ")}`);
    return `${deleted} page(s) deleted`;
  },
};

export const ALL_CHECKS: readonly Check[] = [...coreChecks, ...attachmentChecks, ...searchChecks, ...eventChecks, ...transferChecks, ...pageOrderChecks, ...pageKindChecks, ...shareChecks, ...memberChecks, ...inviteChecks, ...workspaceChecks, ...feedbackChecks, cleanupCheck, responseContractCheck];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the conformance suite against a server. The suite writes pages into one
 * workspace (and deletes them again), so point it at a test workspace.
 *
 * Checks for capabilities the server does not list are reported as `skip`. The bearer
 * token is sent only in the Authorization header and is redacted from every result.
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const client = createClient({ baseUrl: options.baseUrl, token: options.token, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const ctx: Context = {
    client,
    options,
    runId: randomBytes(4).toString("hex"),
    capabilities: null,
    workspaceId: null,
    baselineCursor: null,
    primary: null,
    createdPageIds: new Set(),
    committedTransferId: null,
  };

  const results: CheckResult[] = [];
  for (const check of ALL_CHECKS) {
    const base = { id: check.id, title: check.title, capability: check.capability };
    if (check.capability !== "core") {
      const listed = ctx.capabilities?.capabilities.includes(check.capability);
      if (!listed) {
        const reason = ctx.capabilities ? `server does not list capability "${check.capability}"` : `capabilities are unavailable (core.capabilities.shape did not pass), so "${check.capability}" cannot be assumed`;
        results.push({ ...base, status: "skip", detail: reason });
        continue;
      }
    }
    try {
      const detail = await check.run(ctx);
      results.push({ ...base, status: "pass", detail: client.redact(detail ?? "") });
    } catch (error) {
      if (error instanceof CheckSkip) results.push({ ...base, status: "skip", detail: client.redact(error.message) });
      else results.push({ ...base, status: "fail", detail: client.redact(describeError(error)) });
    }
  }

  const order: CheckGroup[] = [];
  for (const r of results) if (!order.includes(r.capability)) order.push(r.capability);
  const groups: ConformanceGroup[] = order.map((capability) => ({ capability, results: results.filter((r) => r.capability === capability) }));
  return {
    baseUrl: options.baseUrl,
    protocolVersion: ctx.capabilities?.protocolVersion ?? null,
    capabilities: ctx.capabilities ? [...ctx.capabilities.capabilities] : null,
    groups,
    results,
    summary: {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
  };
}

/** Plain-text rendering of a report, grouped by capability. */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [`Thoth workspace protocol conformance: ${report.baseUrl}`, `protocolVersion: ${report.protocolVersion ?? "unknown"}; capabilities: ${report.capabilities ? report.capabilities.join(", ") || "(none)" : "unknown"}`, ""];
  const mark = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;
  for (const group of report.groups) {
    lines.push(`[${group.capability}]`);
    for (const r of group.results) {
      lines.push(`  ${mark[r.status]}  ${r.id}  ${r.title}`);
      if (r.detail) lines.push(`        ${r.detail}`);
    }
    lines.push("");
  }
  lines.push(`${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skip} skipped`);
  return lines.join("\n");
}
