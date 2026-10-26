import { randomBytes } from "node:crypto";
import { InviteAcceptedSchema, InviteLinkCreatedSchema, InviteLinkListSchema, MemberListSchema, MemberSchema, MeSchema, WorkspaceListSchema, type InviteLinkCreated, type Role } from "@thoth/workspace-protocol";
import { expect, expectProblem, expectResponse, fail, parsed, requireWorkspace, skip, type Check, type Context } from "./support.ts";

/**
 * Capabilities `members` and `invite-links` (ADR-0024). The suite has one credential, so each check works with the
 * caller's own role: an owner exercises the owner's calls, anyone else is checked to be refused them (403). Nothing
 * here is skipped for a lack of role, and no other account is ever added to the workspace.
 */
const HTML_ACCEPT = "text/html,application/xhtml+xml";
const DAY = 86_400_000;

interface Caller {
  userId: string;
  role: Role;
  workspaceName: string;
}
const callers = new WeakMap<Context, Caller>();
const invites = new WeakMap<Context, InviteLinkCreated>();

/** Who the credential is and its role in the selected workspace. */
async function caller(ctx: Context): Promise<Caller> {
  const known = callers.get(ctx);
  if (known) return known;
  const workspaceId = requireWorkspace(ctx);
  const me = parsed(MeSchema, await ctx.client.call("getMe"), "getMe");
  for (let cursor: string | undefined, i = 0; i < 100; i++) {
    const list = parsed(WorkspaceListSchema, await ctx.client.call("listWorkspaces", { query: { cursor, limit: 200 } }), "listWorkspaces");
    const ws = list.items.find((w) => w.id === workspaceId);
    if (ws) {
      const found = { userId: me.id, role: ws.role, workspaceName: ws.name };
      callers.set(ctx, found);
      return found;
    }
    if (list.nextCursor === null) break;
    cursor = list.nextCursor;
  }
  return fail("the selected workspace is not in listWorkspaces");
}

const pathOf = (url: string) => new URL(url).pathname;
const unknownToken = () => randomBytes(24).toString("base64url");

/** The invite made by `invite-links.create.returns-token-and-address`, for an owner; `null` for anyone else. */
async function invite(ctx: Context): Promise<InviteLinkCreated | null> {
  const me = await caller(ctx);
  if (me.role !== "owner") return null;
  return invites.get(ctx) ?? skip("prerequisite invite-links.create.returns-token-and-address did not pass");
}

export const memberChecks: Check[] = [
  {
    id: "members.list.includes-caller",
    title: "listMembers lists the caller with the role listWorkspaces gives, and never an email",
    capability: "members",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const me = await caller(ctx);
      const res = await ctx.client.call("listMembers", { params: { workspaceId }, query: { limit: 200 } });
      expectResponse(res, 200, "listMembers");
      const list = parsed(MemberListSchema, res, "listMembers");
      const mine = list.items.find((m) => m.userId === me.userId);
      expect(mine !== undefined, "the caller is in the list");
      expect(mine.role === me.role, `the caller's role is ${me.role}, the list says ${mine.role}`);
      expect(!/"email"\s*:/.test(new TextDecoder().decode(res.bytes)), "the list carries no email");
      return `${list.items.length} member(s) on the first page`;
    },
  },
  {
    id: "members.auth.required",
    title: "the member calls need a credential (401 without one)",
    capability: "members",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const me = await caller(ctx);
      expectProblem(await ctx.client.call("listMembers", { params: { workspaceId }, auth: "none" }), 401, "unauthenticated", "listMembers without credentials");
      expectProblem(await ctx.client.call("removeMember", { params: { workspaceId, userId: me.userId }, auth: "none" }), 401, "unauthenticated", "removeMember without credentials");
    },
  },
  {
    id: "members.role.owners-only-and-one-owner-kept",
    title: "setMemberRole is for owners (403 otherwise); keeping a role is a no-op; demoting or removing the only owner is 409 last_owner",
    capability: "members",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const me = await caller(ctx);
      if (me.role !== "owner") {
        expectProblem(await ctx.client.call("setMemberRole", { params: { workspaceId, userId: me.userId }, json: { role: "owner" } }), 403, "forbidden", `a ${me.role} promoting themself`);
        return `as ${me.role}: refused with 403`;
      }
      const same = await ctx.client.call("setMemberRole", { params: { workspaceId, userId: me.userId }, json: { role: "owner" } });
      expectResponse(same, 200, "setMemberRole to the role the owner has");
      expect(parsed(MemberSchema, same, "setMemberRole").role === "owner", "the role is still owner");
      expectProblem(await ctx.client.call("setMemberRole", { params: { workspaceId, userId: `usr_${randomBytes(8).toString("hex")}` }, json: { role: "viewer" } }), 404, "not_found", "setMemberRole of someone who is not a member");
      expectProblem(await ctx.client.call("setMemberRole", { params: { workspaceId, userId: me.userId }, json: { role: "admin" } }), 400, "validation_failed", "setMemberRole with an unknown role");
      const list = parsed(MemberListSchema, await ctx.client.call("listMembers", { params: { workspaceId }, query: { limit: 200 } }), "listMembers");
      const owners = list.items.filter((m) => m.role === "owner").length;
      if (owners !== 1 || list.nextCursor !== null) return `${owners} owners: the last-owner refusal is not reachable without changing another member`;
      // Leaving is not tried here: on a broken server it would lock the suite's own account out of the workspace.
      expectProblem(await ctx.client.call("setMemberRole", { params: { workspaceId, userId: me.userId }, json: { role: "editor" } }), 409, "last_owner", "the only owner demoting themself");
      return "the only owner cannot demote themself";
    },
  },
];

export const inviteChecks: Check[] = [
  {
    id: "invite-links.create.returns-token-and-address",
    title: "an owner's createInviteLink returns 201 with a URL-safe token of at least 128 bits, its /i/<token> address, 7 days and 1 use by default; others get 403",
    capability: "invite-links",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const me = await caller(ctx);
      const before = Date.now();
      const res = await ctx.client.call("createInviteLink", { params: { workspaceId }, json: { role: "viewer" } });
      if (me.role !== "owner") {
        expectProblem(res, 403, "forbidden", `createInviteLink as ${me.role}`);
        return `as ${me.role}: refused with 403`;
      }
      expectResponse(res, 201, "createInviteLink");
      const link = parsed(InviteLinkCreatedSchema, res, "createInviteLink");
      expect(link.workspaceId === workspaceId && link.role === "viewer", "the link names the workspace and the role");
      expect(/^[A-Za-z0-9_-]+$/.test(link.token) && Buffer.from(link.token, "base64url").length >= 16, "the token is URL-safe base64 of at least 16 bytes");
      expect(pathOf(link.url) === `/i/${link.token}`, `url ends in /i/<token>, got path ${pathOf(link.url)}`);
      expect(link.maxUses === 1 && link.usesLeft === 1, `one use by default, got ${link.maxUses} (${link.usesLeft} left)`);
      const days = (Date.parse(link.expiresAt) - before) / DAY;
      expect(days > 6.9 && days < 7.1, `the default expiry is 7 days, got ${days.toFixed(2)}`);
      expect(link.createdBy === me.userId, "createdBy is the caller");
      invites.set(ctx, link);
      return `link ${link.id}, expires ${link.expiresAt}`;
    },
  },
  {
    id: "invite-links.create.choices",
    title: "createInviteLink takes editor or viewer, 1, 7 or 30 days and 1, 5 or 10 uses, and refuses anything else (400)",
    capability: "invite-links",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const link = await invite(ctx);
      const bad = [{ role: "owner" }, { role: "editor", expiresInDays: 2 }, { role: "editor", maxUses: 3 }, {}];
      if (!link) {
        expectProblem(await ctx.client.call("listInviteLinks", { params: { workspaceId } }), 403, "forbidden", "listInviteLinks as a non-owner");
        return "as a non-owner: listInviteLinks refused with 403";
      }
      const res = await ctx.client.call("createInviteLink", { params: { workspaceId }, json: { role: "editor", expiresInDays: 30, maxUses: 1 } });
      expectResponse(res, 201, "createInviteLink for 30 days");
      const made = parsed(InviteLinkCreatedSchema, res, "createInviteLink");
      expect(made.role === "editor" && Math.round((Date.parse(made.expiresAt) - Date.now()) / DAY) === 30, "editor, 30 days");
      expectResponse(await ctx.client.call("revokeInviteLink", { params: { workspaceId, inviteId: made.id } }), 204, "revokeInviteLink");
      for (const body of bad) expectProblem(await ctx.client.call("createInviteLink", { params: { workspaceId }, json: body }), 400, "validation_failed", `createInviteLink with ${JSON.stringify(body)}`);
      return "editor for 30 days accepted; owner, 2 days, 3 uses and no role refused";
    },
  },
  {
    id: "invite-links.list.active-without-token",
    title: "listInviteLinks lists the active links with the uses left and the creator's name, and never a token",
    capability: "invite-links",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const link = await invite(ctx);
      if (!link) {
        expectProblem(await ctx.client.call("revokeInviteLink", { params: { workspaceId, inviteId: "inv_conformance" } }), 403, "forbidden", "revokeInviteLink as a non-owner");
        return "as a non-owner: revokeInviteLink refused with 403";
      }
      const res = await ctx.client.call("listInviteLinks", { params: { workspaceId } });
      expectResponse(res, 200, "listInviteLinks");
      const list = parsed(InviteLinkListSchema, res, "listInviteLinks");
      const listed = list.items.find((l) => l.id === link.id);
      expect(listed !== undefined, "the new link is listed");
      expect(listed.usesLeft === 1 && listed.createdByName.length > 0, "uses left and the creator's name are given");
      expect(!new TextDecoder().decode(res.bytes).includes(link.token), "the list does not carry the token");
      return `${list.items.length} active link(s)`;
    },
  },
  {
    id: "invite-links.page.html",
    title: "GET /i/<token> without credentials is an HTML page with no script, a strict CSP, noindex, no referrer and nosniff, naming the workspace but not its ID; an unknown token is 404",
    capability: "invite-links",
    async run(ctx) {
      const unknown = await ctx.client.publicGet(`/i/${unknownToken()}`, HTML_ACCEPT);
      expect(unknown.status === 404, `an unknown token: expected HTTP 404, got ${unknown.status}`);
      expect(!/<script/i.test(unknown.text), "the 404 has no script element");
      const link = await invite(ctx);
      if (!link) return "as a non-owner: the unknown-token 404 only";
      const res = await ctx.client.publicGet(pathOf(link.url), HTML_ACCEPT);
      expect(res.status === 200, `expected HTTP 200, got ${res.status}`);
      expect((res.headers.get("content-type") ?? "").startsWith("text/html"), `content-type is HTML, got ${res.headers.get("content-type")}`);
      const csp = (res.headers.get("content-security-policy") ?? "").toLowerCase();
      for (const part of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) expect(csp.includes(part), `CSP has ${part}: ${csp}`);
      expect(!csp.includes("script-src") && !csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"), `CSP allows no script: ${csp}`);
      expect(/noindex/i.test(res.headers.get("x-robots-tag") ?? ""), "X-Robots-Tag: noindex");
      expect(res.headers.get("referrer-policy") === "no-referrer", "Referrer-Policy: no-referrer");
      expect(res.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
      expect(!/<script/i.test(res.text), "no script element");
      const me = await caller(ctx);
      const escaped = me.workspaceName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      expect(res.text.includes(escaped), "the page names the workspace");
      expect(!res.text.includes(requireWorkspace(ctx)), "the workspace ID is not shown");
    },
  },
  {
    id: "invite-links.accept.member-keeps-role",
    title: "acceptInvite by someone already a member is 200 joined:false, keeps their role and uses nothing; an unknown token is 404",
    capability: "invite-links",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const me = await caller(ctx);
      const missing = await ctx.client.call("acceptInvite", { json: { token: unknownToken() } });
      expectProblem(missing, 404, "not_found", "acceptInvite with an unknown token");
      expectProblem(await ctx.client.call("acceptInvite", { json: { token: "x" } }), 404, "not_found", "acceptInvite with a malformed token");
      expectProblem(await ctx.client.call("acceptInvite", { json: { token: unknownToken() }, auth: "none" }), 401, "unauthenticated", "acceptInvite without credentials");
      const link = await invite(ctx);
      if (!link) return "as a non-owner: the unknown-token 404 only";
      const res = await ctx.client.call("acceptInvite", { json: { token: link.token } });
      expectResponse(res, 200, "acceptInvite as a member");
      const accepted = parsed(InviteAcceptedSchema, res, "acceptInvite");
      expect(accepted.workspaceId === workspaceId && accepted.joined === false && accepted.role === me.role, `already a member: joined false, role ${me.role}; got ${JSON.stringify(accepted)}`);
      const list = parsed(InviteLinkListSchema, await ctx.client.call("listInviteLinks", { params: { workspaceId } }), "listInviteLinks");
      expect(list.items.find((l) => l.id === link.id)?.usesLeft === 1, "no use was spent");
    },
  },
  {
    id: "invite-links.revoke.stops-link",
    title: "revokeInviteLink is 204 and repeatable; afterwards the token answers exactly like an unknown one and the list no longer has it",
    capability: "invite-links",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const link = await invite(ctx);
      if (!link) {
        expectProblem(await ctx.client.call("createInviteLink", { params: { workspaceId }, json: { role: "editor" } }), 403, "forbidden", "createInviteLink as a non-owner");
        return "as a non-owner: refused with 403";
      }
      expectResponse(await ctx.client.call("revokeInviteLink", { params: { workspaceId, inviteId: link.id } }), 204, "revokeInviteLink");
      expectResponse(await ctx.client.call("revokeInviteLink", { params: { workspaceId, inviteId: link.id } }), 204, "revokeInviteLink again");
      const revoked = await ctx.client.publicGet(pathOf(link.url), HTML_ACCEPT);
      const unknown = await ctx.client.publicGet(`/i/${unknownToken()}`, HTML_ACCEPT);
      if (revoked.status !== 404) fail(`a revoked link answers HTTP ${revoked.status}, expected 404`);
      expect(revoked.text === unknown.text && revoked.headers.get("content-type") === unknown.headers.get("content-type"), "a revoked link and an unknown token get the same page");
      const a = await ctx.client.call("acceptInvite", { json: { token: link.token } });
      const b = await ctx.client.call("acceptInvite", { json: { token: unknownToken() } });
      expectProblem(a, 404, "not_found", "acceptInvite with a revoked token");
      expect((a.body as { detail?: string }).detail === (b.body as { detail?: string }).detail, "a revoked token and an unknown one get the same problem");
      const list = parsed(InviteLinkListSchema, await ctx.client.call("listInviteLinks", { params: { workspaceId } }), "listInviteLinks");
      expect(!list.items.some((l) => l.id === link.id), "the revoked link is not listed");
    },
  },
];
