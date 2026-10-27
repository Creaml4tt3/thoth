import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runConformance, type ConformanceReport } from "../../protocol/conformance/src/index.ts";
import { EDITOR_TOKEN, LOCKED_WORKSPACE, VIEWER_TOKEN, startBrokenServer, startTestServer, type Flaws, type TestServer } from "./test-server.ts";

const FAST = { searchTimeoutMs: 1500, eventTimeoutMs: 1500 } as const;

const failedIds = (report: ConformanceReport) => report.results.filter((r) => r.status === "fail").map((r) => r.id).sort();
const statusOf = (report: ConformanceReport, id: string) => report.results.find((r) => r.id === id)?.status;

/** The checks the task requires at a minimum. */
const REQUIRED_CHECKS = [
  "core.capabilities.shape",
  "core.errors.unknown-route",
  "core.errors.unauthenticated",
  "core.pages.create-returns-etag",
  "core.pages.get-same-revision",
  "core.pages.write-requires-precondition",
  "core.pages.stale-if-match-conflict",
  "core.revisions.list",
  "core.revisions.immutable",
  "core.idempotency.replay",
  "core.idempotency.key-reuse-different-body",
  "core.changes.includes-write",
  "core.changes.pagination-complete",
  "core.schemas.all-responses-valid",
  "page-order.position-round-trip",
  "page-order.move-metadata-only",
  "page-order.move-preconditions",
  "page-order.move-idempotent",
  "page-kind.derived-from-frontmatter",
  "page-kind.follows-the-latest-write",
  "page-kind.change-feed",
  "members.list.includes-caller",
  "members.role.owners-only-and-one-owner-kept",
  "invite-links.create.returns-token-and-address",
  "invite-links.page.html",
  "invite-links.accept.member-keeps-role",
  "invite-links.revoke.stops-link",
  "workspace-management.create.owner",
  "workspace-management.delete.unreachable",
  "workspace-management.restore",
  "workspace-management.purge",
];

describe("conformance suite against a correct server", () => {
  let server: TestServer;
  let report: ConformanceReport;

  beforeAll(async () => {
    server = await startTestServer();
    report = await runConformance({ baseUrl: server.url, token: server.token, ...FAST });
  });
  afterAll(() => server.close());

  it("passes every check, with nothing skipped", () => {
    expect(report.results.filter((r) => r.status !== "pass").map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
    expect(report.summary).toEqual({ pass: report.results.length, fail: 0, skip: 0 });
  });

  it("runs every required check", () => {
    const ids = report.results.map((r) => r.id);
    for (const id of REQUIRED_CHECKS) expect(ids, id).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns structured results grouped by capability", () => {
    expect(report.protocolVersion).toBe("1.0");
    expect(report.capabilities).toEqual(["attachments", "search", "events.sse", "transfers", "page-order", "page-kind", "public-share", "members", "invite-links", "workspace-management", "feedback"]);
    expect(report.groups.map((g) => g.capability)).toEqual(["core", "attachments", "search", "events.sse", "transfers", "page-order", "page-kind", "public-share", "members", "invite-links", "workspace-management", "feedback"]);
    for (const group of report.groups) {
      expect(group.results.length).toBeGreaterThan(0);
      for (const r of group.results) {
        expect(r.capability).toBe(group.capability);
        expect(r.id.startsWith(`${group.capability}.`) || group.capability === "core").toBe(true);
        expect(r.title).toBeTruthy();
        expect(["pass", "fail", "skip"]).toContain(r.status);
        expect(typeof r.detail).toBe("string");
      }
    }
    expect(report.groups.flatMap((g) => g.results)).toHaveLength(report.results.length);
  });

  it("leaves no pages behind", async () => {
    const res = await fetch(`${server.url}/api/v1/workspaces/ws_main/tree`, { headers: { authorization: `Bearer ${EDITOR_TOKEN}` } });
    expect((await res.json()) as { items: unknown[] }).toMatchObject({ items: [] });
  });

  it("never puts the token into the report", () => {
    expect(JSON.stringify(report)).not.toContain(EDITOR_TOKEN);
  });
});

describe("capability skipping", () => {
  it("skips every optional-capability check when the server lists none", async () => {
    const server = await startTestServer({ capabilities: [] });
    try {
      const report = await runConformance({ baseUrl: server.url, token: server.token, ...FAST });
      expect(report.capabilities).toEqual([]);
      expect(report.summary.fail).toBe(0);
      const optional = report.results.filter((r) => r.capability !== "core");
      expect(optional.length).toBeGreaterThan(8);
      for (const r of optional) {
        expect(r.status, r.id).toBe("skip");
        expect(r.detail).toMatch(/does not list capability/);
      }
      for (const r of report.results.filter((r) => r.capability === "core")) expect(r.status, r.id).toBe("pass");
    } finally {
      await server.close();
    }
  });

  it("runs only the checks of the capabilities that are listed", async () => {
    const server = await startTestServer({ capabilities: ["search"] });
    try {
      const report = await runConformance({ baseUrl: server.url, token: server.token, ...FAST });
      expect(report.summary.fail).toBe(0);
      expect(report.results.filter((r) => r.capability === "search").every((r) => r.status === "pass")).toBe(true);
      for (const capability of ["attachments", "events.sse", "transfers", "page-order", "page-kind"]) {
        expect(report.results.filter((r) => r.capability === capability).every((r) => r.status === "skip"), capability).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it("skips page-kind checks, and passes everything else, for a server without the capability (it omits kind)", async () => {
    const server = await startTestServer({ capabilities: ["attachments", "search", "events.sse", "transfers", "page-order"] });
    try {
      const report = await runConformance({ baseUrl: server.url, token: server.token, ...FAST });
      expect(report.summary.fail).toBe(0);
      expect(report.results.filter((r) => r.capability === "page-kind").every((r) => r.status === "skip")).toBe(true);
      const tree = await fetch(`${server.url}/api/v1/workspaces/ws_main/tree`, { headers: { authorization: `Bearer ${EDITOR_TOKEN}` } });
      expect(JSON.stringify(await tree.json())).not.toContain('"kind"');
    } finally {
      await server.close();
    }
  });

  it("accepts vendor capabilities and ignores them", async () => {
    const server = await startTestServer({ capabilities: ["x-acme.graph"] });
    try {
      const report = await runConformance({ baseUrl: server.url, token: server.token, ...FAST });
      expect(report.capabilities).toEqual(["x-acme.graph"]);
      expect(statusOf(report, "core.capabilities.shape")).toBe("pass");
      expect(report.summary.fail).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("does not assume capabilities when the capabilities check itself fails", async () => {
    const server = await startTestServer();
    try {
      const broken: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/api/v1/capabilities")) return new Response(JSON.stringify({ protocolVersion: "one" }), { status: 200, headers: { "content-type": "application/json" } });
        return fetch(input, init);
      };
      const report = await runConformance({ baseUrl: server.url, token: server.token, fetch: broken, ...FAST });
      expect(statusOf(report, "core.capabilities.shape")).toBe("fail");
      expect(report.capabilities).toBeNull();
      for (const r of report.results.filter((x) => x.capability !== "core")) {
        expect(r.status).toBe("skip");
        expect(r.detail).toMatch(/capabilities are unavailable/);
      }
    } finally {
      await server.close();
    }
  });
});

describe("principals and workspaces", () => {
  it("skips write checks, without failing, when the principal can only read", async () => {
    const server = await startTestServer();
    try {
      const report = await runConformance({ baseUrl: server.url, token: VIEWER_TOKEN, ...FAST });
      expect(report.summary.fail).toBe(0);
      expect(statusOf(report, "core.workspaces.list")).toBe("pass");
      expect(statusOf(report, "core.pages.create-returns-etag")).toBe("skip");
      expect(statusOf(report, "core.errors.unauthenticated")).toBe("pass");
      expect(report.results.find((r) => r.id === "core.tree.shape")!.detail).toMatch(/no workspace where the principal is owner or editor/);
    } finally {
      await server.close();
    }
  });

  it("honors the workspaceId option, and skips export paths in an export-restricted workspace", async () => {
    const server = await startTestServer();
    try {
      const report = await runConformance({ baseUrl: server.url, token: server.token, workspaceId: LOCKED_WORKSPACE, ...FAST });
      expect(report.summary.fail).toBe(0);
      expect(report.results.find((r) => r.id === "core.workspaces.list")!.detail).toContain(LOCKED_WORKSPACE);
      for (const id of ["transfers.from-workspace-copy", "transfers.from-workspace-move"]) {
        expect(statusOf(report, id), id).toBe("skip");
        expect(report.results.find((r) => r.id === id)!.detail).toMatch(/export restricted/);
      }
      expect(statusOf(report, "transfers.commit")).toBe("pass");
    } finally {
      await server.close();
    }
  });

  it("skips writes when the requested workspace is not available to the principal", async () => {
    const server = await startTestServer();
    try {
      const report = await runConformance({ baseUrl: server.url, token: server.token, workspaceId: "ws_does_not_exist", ...FAST });
      expect(report.summary.fail).toBe(0);
      expect(statusOf(report, "core.pages.create-returns-etag")).toBe("skip");
    } finally {
      await server.close();
    }
  });
});

describe("conformance suite against deliberately broken servers", () => {
  async function runAgainst(flaws: Flaws): Promise<ConformanceReport> {
    const server = await startBrokenServer({ flaws: { overwriteOnStale: false, plainJsonErrors: false, badIdempotency: false, ...flaws } });
    try {
      return await runConformance({ baseUrl: server.url, token: server.token, ...FAST });
    } finally {
      await server.close();
    }
  }

  it("catches a server that overwrites on stale writes", async () => {
    const report = await runAgainst({ overwriteOnStale: true });
    expect(failedIds(report)).toEqual(["core.pages.delete", "core.pages.stale-if-match-conflict", "page-order.move-preconditions"]);
    expect(report.results.find((r) => r.id === "core.pages.stale-if-match-conflict")!.detail).toMatch(/instead of 412 and it overwrote the page/);
    expect(report.results.find((r) => r.id === "core.pages.delete")!.detail).toMatch(/stale If-Match succeeded/);
    // Everything about the response format is still right.
    expect(statusOf(report, "core.schemas.all-responses-valid")).toBe("pass");
    expect(statusOf(report, "core.errors.unknown-route")).toBe("pass");
  });

  it("catches a server that returns plain JSON errors", async () => {
    const report = await runAgainst({ plainJsonErrors: true });
    const failed = failedIds(report);
    for (const id of ["core.errors.unknown-route", "core.errors.unauthenticated", "core.pages.write-requires-precondition", "core.pages.create-twice-conflict", "core.pages.stale-if-match-conflict", "core.pages.validation-failed", "core.pages.not-found", "core.changes.cursor-invalid", "core.schemas.all-responses-valid"]) {
      expect(failed, id).toContain(id);
    }
    expect(report.results.find((r) => r.id === "core.errors.unknown-route")!.detail).toMatch(/application\/problem\+json/);
    // Success-path behavior is untouched by this flaw.
    for (const id of ["core.capabilities.shape", "core.pages.create-returns-etag", "core.pages.get-same-revision", "core.pages.update-with-if-match", "core.revisions.list", "core.revisions.immutable", "core.idempotency.replay", "core.changes.pagination-complete", "attachments.upload-download", "search.finds-page", "events.sse.hint-after-write", "transfers.commit"]) {
      expect(statusOf(report, id), id).toBe("pass");
    }
  });

  it("catches a server that mishandles idempotency keys", async () => {
    const report = await runAgainst({ badIdempotency: true });
    expect(failedIds(report)).toEqual(["attachments.idempotent-upload", "core.idempotency.key-reuse-different-body", "core.idempotency.replay", "page-order.move-idempotent"]);
    expect(report.results.find((r) => r.id === "core.idempotency.replay")!.detail).toMatch(/expected HTTP 201, got 412/);
    expect(report.results.find((r) => r.id === "core.idempotency.key-reuse-different-body")!.detail).toMatch(/expected HTTP 422/);
  });

  it("catches a server that derives the page kind only on create", async () => {
    const report = await runAgainst({ staleKind: true });
    expect(failedIds(report)).toEqual(["page-kind.follows-the-latest-write"]);
    expect(report.results.find((r) => r.id === "page-kind.follows-the-latest-write")!.detail).toMatch(/did not make the page a folder/);
  });

  it("notices an invite link that keeps working after it was revoked (ADR-0024)", async () => {
    const report = await runAgainst({ inviteRevokeIgnored: true });
    expect(failedIds(report)).toEqual(["invite-links.revoke.stops-link"]);
    expect(report.results.find((r) => r.id === "invite-links.revoke.stops-link")!.detail).toMatch(/revoked link answers HTTP 200/);
  });

  it("notices a deleted workspace that still answers (ADR-0025)", async () => {
    const report = await runAgainst({ deletedStillReachable: true });
    expect(failedIds(report)).toEqual(["workspace-management.delete.unreachable"]);
    expect(report.results.find((r) => r.id === "workspace-management.delete.unreachable")!.detail).toMatch(/getWorkspaceTree of a deleted workspace: expected HTTP 404, got 200/);
  });

  it("fails each of them at once on the fully broken server, but still returns a complete report", async () => {
    const server = await startBrokenServer();
    try {
      const report = await runConformance({ baseUrl: server.url, token: server.token, ...FAST });
      const failed = new Set(failedIds(report));
      for (const id of ["core.pages.stale-if-match-conflict", "core.errors.unknown-route", "core.idempotency.replay", "core.idempotency.key-reuse-different-body"]) expect(failed.has(id), id).toBe(true);
      expect(report.summary.fail).toBeGreaterThan(15);
      expect(report.summary.pass + report.summary.fail + report.summary.skip).toBe(report.results.length);
      expect(statusOf(report, "core.capabilities.shape")).toBe("pass");
    } finally {
      await server.close();
    }
  });
});

describe("token handling", () => {
  it("redacts the token from results even when the server echoes it", async () => {
    const server = await startTestServer();
    try {
      const echoing: typeof fetch = async (input, init) => {
        const real = await fetch(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("conformance-unknown-route")) return real;
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        const body = { type: "about:blank", title: "Not found", status: 404, code: `x-${auth.replace("Bearer ", "")}` };
        return new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/problem+json" } });
      };
      const report = await runConformance({ baseUrl: server.url, token: server.token, fetch: echoing, ...FAST });
      const unknown = report.results.find((r) => r.id === "core.errors.unknown-route")!;
      expect(unknown.status).toBe("fail");
      expect(unknown.detail).toContain("[redacted]");
      expect(JSON.stringify(report)).not.toContain(EDITOR_TOKEN);
    } finally {
      await server.close();
    }
  });

  it("redacts the token from network errors", async () => {
    const leaky: typeof fetch = async (_input, init) => {
      throw new Error(`connect failed with ${new Headers(init?.headers).get("authorization") ?? "no auth"}`);
    };
    const report = await runConformance({ baseUrl: "http://127.0.0.1:9", token: EDITOR_TOKEN, fetch: leaky });
    expect(report.summary.fail).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(EDITOR_TOKEN);
    expect(JSON.stringify(report)).toContain("[redacted]");
  });

  it("only sends the token as a bearer credential to protected routes, never to GET /capabilities", async () => {
    const server = await startTestServer();
    try {
      const seen: { url: string; auth: string | null }[] = [];
      const spy: typeof fetch = async (input, init) => {
        seen.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, auth: new Headers(init?.headers).get("authorization") });
        return fetch(input, init);
      };
      await runConformance({ baseUrl: server.url, token: server.token, fetch: spy, ...FAST });
      expect(seen.find((s) => s.url.endsWith("/api/v1/capabilities"))!.auth).toBeNull();
      expect(seen.some((s) => s.auth === `Bearer ${EDITOR_TOKEN}`)).toBe(true);
      expect(seen.every((s) => !s.url.includes(EDITOR_TOKEN))).toBe(true);
      expect(server.requestCount()).toBe(seen.length);
    } finally {
      await server.close();
    }
  });
});

describe("unreachable servers", () => {
  it("reports failures instead of throwing", async () => {
    const server = await startTestServer();
    const url = server.url;
    await server.close();
    const report = await runConformance({ baseUrl: url, token: "tok_x", ...FAST });
    expect(statusOf(report, "core.capabilities.shape")).toBe("fail");
    expect(report.results.find((r) => r.id === "core.capabilities.shape")!.detail).toMatch(/network error/);
    expect(report.summary.pass).toBe(0);
  });
});
