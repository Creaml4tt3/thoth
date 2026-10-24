import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runConformance, formatReport, type ConformanceReport } from "../../../protocol/conformance/src/index.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";

const FAST = { searchTimeoutMs: 5000, eventTimeoutMs: 5000 } as const;

describe("conformance suite against the reference server (real PostgreSQL)", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let workspaceId: string;
  let report: ConformanceReport;

  beforeAll(async () => {
    env = await startTestEnv();
    owner = await env.user("Conformance Owner");
    workspaceId = await env.workspace("Conformance", { members: { [owner.userId]: "owner" } });
    report = await runConformance({ baseUrl: env.url, token: owner.token, workspaceId, ...FAST });
    process.stderr.write(`conformance: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skip} skipped\n`);
  });
  afterAll(() => env.close());

  it("passes every check, with nothing skipped and nothing failed", () => {
    const notPassed = report.results.filter((r) => r.status !== "pass").map((r) => `${r.status} ${r.id}: ${r.detail}`);
    if (notPassed.length) console.log(formatReport(report));
    expect(notPassed).toEqual([]);
    expect(report.summary).toEqual({ pass: report.results.length, fail: 0, skip: 0 });
    expect(report.results.length).toBeGreaterThanOrEqual(35);
  });

  it("lists exactly the six capabilities the server implements", () => {
    expect(report.capabilities).toEqual(["attachments", "search", "events.sse", "transfers", "page-order", "page-kind"]);
    expect(report.groups.map((g) => g.capability)).toEqual(["core", "attachments", "search", "events.sse", "transfers", "page-order", "page-kind"]);
  });

  it("also passes for an editor (not only an owner)", async () => {
    const editor = await env.user("Conformance Editor");
    const ws = await env.workspace("Editors", { members: { [editor.userId]: "editor" } });
    const editorReport = await runConformance({ baseUrl: env.url, token: editor.token, workspaceId: ws, ...FAST });
    expect(editorReport.results.filter((r) => r.status !== "pass").map((r) => `${r.status} ${r.id}: ${r.detail}`)).toEqual([]);
    expect(editorReport.summary.skip).toBe(0);
  });

  it("leaves no pages behind", async () => {
    const tree = await env.api(owner, "GET", `/workspaces/${workspaceId}/tree`);
    expect(tree.json.items).toEqual([]);
  });

  it("never puts the token into the report", () => {
    expect(JSON.stringify(report)).not.toContain(owner.token);
  });
});
