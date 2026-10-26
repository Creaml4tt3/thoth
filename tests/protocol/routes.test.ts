import { describe, expect, it } from "vitest";
import {
  API_BASE_PATH,
  COMMON_ERRORS,
  ERROR_CODES,
  KNOWN_CAPABILITIES,
  PROBLEM_CONTENT_TYPE,
  ROUTES,
  allowedStatuses,
  buildRequestPath,
  getRoute,
  pathParamNames,
  problem,
  validateResponse,
  validateUnroutedProblem,
} from "@thoth/workspace-protocol";
import { SPEC_ENDPOINTS } from "./spec-endpoints.ts";

const SAMPLE_PAGE_ID = "01a15cc9-7d0d-7982-a22a-e5ae3df6b019";

describe("route registry", () => {
  it("contains every endpoint of spec section 8", () => {
    for (const [method, path] of SPEC_ENDPOINTS) {
      expect(ROUTES.some((r) => r.method === method && r.path === path), `${method.toUpperCase()} ${path}`).toBe(true);
    }
  });

  it("has unique operationIds and unique method+path pairs", () => {
    expect(new Set(ROUTES.map((r) => r.operationId)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTES.length);
  });

  it("declares a schema for exactly the placeholders of each path", () => {
    for (const r of ROUTES) expect(Object.keys(r.pathParams).sort(), r.operationId).toEqual(pathParamNames(r.path).sort());
  });

  it("only uses registered error codes, with the common errors on every authenticated route", () => {
    for (const r of ROUTES) {
      for (const code of r.errors) expect(ERROR_CODES, `${r.operationId}: ${code}`).toHaveProperty(code);
      if (!r.public) for (const code of COMMON_ERRORS) expect(r.errors, r.operationId).toContain(code);
    }
  });

  it("makes capability-gated routes return capability_not_supported, and only those", () => {
    for (const r of ROUTES) {
      expect(r.errors.includes("capability_not_supported"), r.operationId).toBe(r.capability !== null);
      if (r.capability) expect(KNOWN_CAPABILITIES as readonly string[]).toContain(r.capability);
    }
    const gated = Object.fromEntries(ROUTES.filter((r) => r.capability).map((r) => [r.operationId, r.capability]));
    expect(gated).toEqual({
      searchWorkspace: "search",
      uploadAttachment: "attachments",
      getAttachment: "attachments",
      streamWorkspaceEvents: "events.sse",
      createTransfer: "transfers",
      getTransfer: "transfers",
      commitTransfer: "transfers",
      abortTransfer: "transfers",
      movePage: "page-order",
      createShareLink: "public-share",
      listShareLinks: "public-share",
      revokeShareLink: "public-share",
      listMembers: "members",
      setMemberRole: "members",
      removeMember: "members",
      createInviteLink: "invite-links",
      listInviteLinks: "invite-links",
      revokeInviteLink: "invite-links",
      acceptInvite: "invite-links",
      createWorkspace: "workspace-management",
      renameWorkspace: "workspace-management",
      deleteWorkspace: "workspace-management",
      listDeletedWorkspaces: "workspace-management",
      restoreWorkspace: "workspace-management",
      purgeWorkspace: "workspace-management",
    });
  });

  it("puts the workspace-management calls where ADR-0025 says: create with Idempotency-Key, owners-only changes, restore and purge of deleted ones", () => {
    const at = (id: string) => `${getRoute(id).method.toUpperCase()} ${getRoute(id).path}`;
    expect(at("createWorkspace")).toBe("POST /workspaces");
    expect(at("renameWorkspace")).toBe("PUT /workspaces/{workspaceId}/name");
    expect(at("deleteWorkspace")).toBe("DELETE /workspaces/{workspaceId}");
    expect(at("listDeletedWorkspaces")).toBe("GET /deleted-workspaces");
    expect(at("restoreWorkspace")).toBe("POST /deleted-workspaces/{workspaceId}/restore");
    expect(at("purgeWorkspace")).toBe("DELETE /deleted-workspaces/{workspaceId}");
    expect(getRoute("createWorkspace").responses.map((r) => r.status)).toEqual([201]);
    expect(getRoute("createWorkspace").errors).toEqual(expect.arrayContaining(["validation_failed", "quota_exceeded", "idempotency_key_reused"]));
    for (const id of ["createWorkspace", "renameWorkspace", "deleteWorkspace", "restoreWorkspace", "purgeWorkspace"]) {
      expect(getRoute(id).requestHeaders.find((h) => h.name === "Idempotency-Key")?.requirement, id).toBe("optional");
    }
    for (const id of ["renameWorkspace", "deleteWorkspace", "restoreWorkspace", "purgeWorkspace"]) expect(getRoute(id).errors, id).toEqual(expect.arrayContaining(["forbidden", "not_found"]));
    expect(getRoute("deleteWorkspace").responses.map((r) => r.status)).toEqual([204]);
    expect(getRoute("purgeWorkspace").responses.map((r) => r.status)).toEqual([204]);
  });

  it("puts the members and invite-link calls where ADR-0024 says, with last_owner on the calls that can empty the owners", () => {
    const at = (id: string) => `${getRoute(id).method.toUpperCase()} ${getRoute(id).path}`;
    expect(at("listMembers")).toBe("GET /workspaces/{workspaceId}/members");
    expect(at("setMemberRole")).toBe("PUT /workspaces/{workspaceId}/members/{userId}");
    expect(at("removeMember")).toBe("DELETE /workspaces/{workspaceId}/members/{userId}");
    expect(at("createInviteLink")).toBe("POST /workspaces/{workspaceId}/invite-links");
    expect(at("listInviteLinks")).toBe("GET /workspaces/{workspaceId}/invite-links");
    expect(at("revokeInviteLink")).toBe("DELETE /workspaces/{workspaceId}/invite-links/{inviteId}");
    expect(at("acceptInvite")).toBe("POST /invites/accept");
    for (const id of ["setMemberRole", "removeMember"]) expect(getRoute(id).errors, id).toEqual(expect.arrayContaining(["last_owner", "forbidden", "not_found"]));
    expect(getRoute("setMemberRole").errors).toContain("quota_exceeded");
    expect(getRoute("createInviteLink").errors).toEqual(expect.arrayContaining(["forbidden", "not_found", "quota_exceeded", "validation_failed"]));
    expect(getRoute("acceptInvite").errors).toEqual(expect.arrayContaining(["not_found", "quota_exceeded", "rate_limited"]));
    // A replayed create would have to store the token: Idempotency-Key is not offered there.
    expect(getRoute("createInviteLink").requestHeaders).toEqual([]);
    expect(getRoute("acceptInvite").requestHeaders).toEqual([]);
  });

  it("only exposes GET /capabilities without credentials", () => {
    expect(ROUTES.filter((r) => r.public).map((r) => r.operationId)).toEqual(["getCapabilities"]);
  });

  it("declares the conditional-write headers on page writes", () => {
    const put = getRoute("putPage");
    const names = Object.fromEntries(put.requestHeaders.map((h) => [h.name, h.requirement]));
    expect(names).toEqual({ "If-Match": "conditional", "If-None-Match": "conditional", "Idempotency-Key": "optional" });
    expect(put.responses.map((r) => r.status)).toEqual([200, 201]);
    for (const r of put.responses) expect(r.headers.map((h) => h.name)).toContain("ETag");
    expect(put.errors).toEqual(expect.arrayContaining(["precondition_required", "revision_conflict", "idempotency_key_reused", "validation_failed"]));
    const del = getRoute("deletePage");
    expect(del.requestHeaders.find((h) => h.name === "If-Match")?.requirement).toBe("required");
    expect(del.errors).toEqual(expect.arrayContaining(["precondition_required", "revision_conflict"]));
    expect(getRoute("getPage").responses[0]!.headers.map((h) => h.name)).toEqual(["ETag"]);
  });

  it("requires an Idempotency-Key to create a transfer", () => {
    expect(getRoute("createTransfer").requestHeaders.find((h) => h.name === "Idempotency-Key")?.requirement).toBe("required");
  });

  it("builds request paths under /api/v1 and percent-encodes parameters", () => {
    expect(buildRequestPath(getRoute("getPage"), { workspaceId: "ws a/b", pageId: SAMPLE_PAGE_ID })).toBe(`${API_BASE_PATH}/workspaces/ws%20a%2Fb/pages/${SAMPLE_PAGE_ID}`);
    expect(() => buildRequestPath(getRoute("getPage"), { workspaceId: "ws" })).toThrow(/pageId/);
  });

  it("derives allowed statuses from success responses and error codes", () => {
    expect(allowedStatuses(getRoute("putPage"))).toEqual([200, 201, 400, 401, 403, 404, 409, 412, 413, 422, 428, 429, 500, 503]);
  });
});

describe("validateResponse", () => {
  const getPage = getRoute("getPage");
  const sampleBody = {
    id: SAMPLE_PAGE_ID,
    markdown: "# x",
    revision: { id: "r1", pageId: SAMPLE_PAGE_ID, parentId: null, createdAt: "2026-10-21T10:00:00Z", authorId: null, title: "x", size: 3, contentHash: "a".repeat(64) },
    metadata: { workspaceId: "w", parentId: null, title: "x", createdAt: "2026-10-21T10:00:00Z", createdBy: null, updatedAt: "2026-10-21T10:00:00Z", updatedBy: null },
  };

  it("accepts a conforming success response and a conforming problem", () => {
    expect(validateResponse(getPage, { status: 200, contentType: "application/json; charset=utf-8", body: sampleBody })).toEqual([]);
    expect(validateResponse(getPage, { status: 404, contentType: PROBLEM_CONTENT_TYPE, body: problem("not_found") })).toEqual([]);
  });

  it("rejects an undeclared status", () => {
    expect(validateResponse(getPage, { status: 418, contentType: PROBLEM_CONTENT_TYPE, body: {} }).join()).toMatch(/not declared/);
    expect(validateResponse(getPage, { status: 412, contentType: PROBLEM_CONTENT_TYPE, body: problem("revision_conflict") }).join()).toMatch(/not declared/);
  });

  it("rejects errors that are plain JSON, lack a code, or carry a mismatched status", () => {
    expect(validateResponse(getPage, { status: 404, contentType: "application/json", body: problem("not_found") }).join()).toMatch(/content-type/);
    expect(validateResponse(getPage, { status: 404, contentType: PROBLEM_CONTENT_TYPE, body: { error: "nope" } }).length).toBeGreaterThan(0);
    expect(validateResponse(getPage, { status: 404, contentType: PROBLEM_CONTENT_TYPE, body: { ...problem("not_found"), status: 400 } }).join()).toMatch(/differs/);
  });

  it("rejects a registered code that the route does not declare, and a code on the wrong status", () => {
    expect(validateResponse(getPage, { status: 404, contentType: PROBLEM_CONTENT_TYPE, body: problem("precondition_required") }).join()).toMatch(/must use HTTP 428|not declared/);
    expect(validateResponse(getPage, { status: 400, contentType: PROBLEM_CONTENT_TYPE, body: problem("cursor_invalid") }).join()).toMatch(/not declared/);
  });

  it("requires the revision on 412 revision_conflict", () => {
    const put = getRoute("putPage");
    expect(validateResponse(put, { status: 412, contentType: PROBLEM_CONTENT_TYPE, body: problem("revision_conflict") }).join()).toMatch(/currentRevision/);
    expect(validateResponse(put, { status: 412, contentType: PROBLEM_CONTENT_TYPE, body: { ...problem("revision_conflict"), currentRevision: sampleBody.revision } })).toEqual([]);
  });

  it("flags success bodies that break the schema and unparseable bodies", () => {
    expect(validateResponse(getPage, { status: 200, contentType: "application/json", body: { ...sampleBody, markdown: 5 } }).join()).toMatch(/markdown/);
    expect(validateResponse(getPage, { status: 200, contentType: "application/json", body: undefined, bodyUnparseable: true }).join()).toMatch(/not valid JSON/);
    expect(validateResponse(getPage, { status: 200, contentType: "text/html", body: sampleBody }).join()).toMatch(/content-type/);
  });

  it("validates problems for requests that matched no route", () => {
    expect(validateUnroutedProblem({ status: 404, contentType: PROBLEM_CONTENT_TYPE, body: problem("not_found") })).toEqual([]);
    expect(validateUnroutedProblem({ status: 404, contentType: "text/html", body: undefined }).length).toBeGreaterThan(0);
  });
});
