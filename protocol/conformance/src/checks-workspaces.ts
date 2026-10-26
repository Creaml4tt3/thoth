import { DeletedWorkspaceListSchema, QuotaExceededProblemSchema, WorkspaceListSchema, WorkspaceSchema, type Workspace } from "@thoth/workspace-protocol";
import { expect, expectProblem, expectResponse, parsed, requireWorkspace, skip, type Check, type Context } from "./support.ts";

/**
 * Capability `workspace-management` (ADR-0025). The suite creates one workspace of its own, renames it, deletes it,
 * restores it, deletes it again and purges it, so nothing is left behind and the selected workspace is never changed.
 * Any signed-in account may create a workspace, so these checks need no particular role.
 */
const made = new WeakMap<Context, Workspace>();

async function listedIds(ctx: Context): Promise<string[]> {
  const ids: string[] = [];
  for (let cursor: string | undefined, i = 0; i < 100; i++) {
    const list = parsed(WorkspaceListSchema, await ctx.client.call("listWorkspaces", { query: { cursor, limit: 200 } }), "listWorkspaces");
    ids.push(...list.items.map((w) => w.id));
    if (list.nextCursor === null) break;
    cursor = list.nextCursor;
  }
  return ids;
}

async function deletedIds(ctx: Context): Promise<string[]> {
  const res = await ctx.client.call("listDeletedWorkspaces", { query: { limit: 200 } });
  expectResponse(res, 200, "listDeletedWorkspaces");
  return parsed(DeletedWorkspaceListSchema, res, "listDeletedWorkspaces").items.map((w) => w.id);
}

const ours = (ctx: Context): Workspace => made.get(ctx) ?? skip("prerequisite workspace-management.create.owner did not pass");

export const workspaceChecks: Check[] = [
  {
    id: "workspace-management.create.owner",
    title: "createWorkspace returns 201 with the caller as the only member and owner, trims the name, and the workspace is listed",
    capability: "workspace-management",
    async run(ctx) {
      const res = await ctx.client.call("createWorkspace", { json: { name: `  Conformance ${ctx.runId}  ` } });
      if (res.status === 409) {
        const problem = QuotaExceededProblemSchema.safeParse(res.body);
        expect(problem.success, "a 409 is a quota_exceeded problem");
        skip(`the account may not create another workspace here (${problem.data.quota ?? "quota"}: ${problem.data.current ?? "?"} of ${problem.data.limit ?? "?"})`);
      }
      expectResponse(res, 201, "createWorkspace");
      const ws = parsed(WorkspaceSchema, res, "createWorkspace");
      made.set(ctx, ws);
      expect(ws.name === `Conformance ${ctx.runId}`, `the name is trimmed, got ${JSON.stringify(ws.name)}`);
      expect(ws.role === "owner" && ws.memberCount === 1, `the caller is the only member, as owner (got ${ws.role}, ${ws.memberCount} members)`);
      expect((await listedIds(ctx)).includes(ws.id), "listWorkspaces includes the new workspace");
      return `workspace ${ws.id}`;
    },
  },
  {
    id: "workspace-management.create.refusals",
    title: "createWorkspace refuses an empty or too long name (400 validation_failed) and needs a credential (401)",
    capability: "workspace-management",
    async run(ctx) {
      for (const name of ["", "   ", "x".repeat(201)]) expectProblem(await ctx.client.call("createWorkspace", { json: { name } }), 400, "validation_failed", `createWorkspace with a name of ${name.length} characters`);
      expectProblem(await ctx.client.call("createWorkspace", { json: {} }), 400, "validation_failed", "createWorkspace without a name");
      expectProblem(await ctx.client.call("createWorkspace", { json: { name: "Nope" }, auth: "none" }), 401, "unauthenticated", "createWorkspace without credentials");
    },
  },
  {
    id: "workspace-management.rename",
    title: "an owner's renameWorkspace returns 200 with the new name, which listWorkspaces shows; a non-owner of the selected workspace gets 403",
    capability: "workspace-management",
    async run(ctx) {
      const ws = ours(ctx);
      const res = await ctx.client.call("renameWorkspace", { params: { workspaceId: ws.id }, json: { name: `Renamed ${ctx.runId}` } });
      expectResponse(res, 200, "renameWorkspace");
      expect(parsed(WorkspaceSchema, res, "renameWorkspace").name === `Renamed ${ctx.runId}`, "the reply has the new name");
      expectProblem(await ctx.client.call("renameWorkspace", { params: { workspaceId: ws.id }, json: { name: "" } }), 400, "validation_failed", "renameWorkspace to an empty name");
      const selected = requireWorkspace(ctx);
      const list = parsed(WorkspaceListSchema, await ctx.client.call("listWorkspaces", { query: { limit: 200 } }), "listWorkspaces");
      const mine = list.items.find((w) => w.id === ws.id);
      expect(mine?.name === `Renamed ${ctx.runId}`, "listWorkspaces shows the new name");
      const role = list.items.find((w) => w.id === selected)?.role;
      if (role !== undefined && role !== "owner") {
        expectProblem(await ctx.client.call("renameWorkspace", { params: { workspaceId: selected }, json: { name: "Not mine" } }), 403, "forbidden", `renameWorkspace as ${role}`);
        expectProblem(await ctx.client.call("deleteWorkspace", { params: { workspaceId: selected } }), 403, "forbidden", `deleteWorkspace as ${role}`);
        return `renamed; as ${role} of the selected workspace: refused with 403`;
      }
      return "renamed";
    },
  },
  {
    id: "workspace-management.delete.unreachable",
    title: "deleteWorkspace is 204; the workspace then answers 404 and is not listed, and listDeletedWorkspaces has it with restorableUntil after deletedAt",
    capability: "workspace-management",
    async run(ctx) {
      const ws = ours(ctx);
      expectResponse(await ctx.client.call("deleteWorkspace", { params: { workspaceId: ws.id } }), 204, "deleteWorkspace");
      expectProblem(await ctx.client.call("getWorkspaceTree", { params: { workspaceId: ws.id } }), 404, "not_found", "getWorkspaceTree of a deleted workspace");
      expectProblem(await ctx.client.call("listWorkspaceChanges", { params: { workspaceId: ws.id } }), 404, "not_found", "listWorkspaceChanges of a deleted workspace");
      expectProblem(await ctx.client.call("deleteWorkspace", { params: { workspaceId: ws.id } }), 404, "not_found", "deleteWorkspace again");
      expect(!(await listedIds(ctx)).includes(ws.id), "listWorkspaces leaves the deleted workspace out");
      const list = parsed(DeletedWorkspaceListSchema, await ctx.client.call("listDeletedWorkspaces", { query: { limit: 200 } }), "listDeletedWorkspaces");
      const item = list.items.find((w) => w.id === ws.id);
      expect(item !== undefined, "listDeletedWorkspaces has it");
      expect(Date.parse(item.restorableUntil) > Date.parse(item.deletedAt), "restorableUntil is after deletedAt");
      return `restorable until ${item.restorableUntil}`;
    },
  },
  {
    id: "workspace-management.restore",
    title: "restoreWorkspace is 200 and the workspace is reachable and listed again; restoring a live workspace is 404",
    capability: "workspace-management",
    async run(ctx) {
      const ws = ours(ctx);
      const res = await ctx.client.call("restoreWorkspace", { params: { workspaceId: ws.id } });
      expectResponse(res, 200, "restoreWorkspace");
      expect(parsed(WorkspaceSchema, res, "restoreWorkspace").id === ws.id, "the reply is the workspace");
      expectResponse(await ctx.client.call("getWorkspaceTree", { params: { workspaceId: ws.id } }), 200, "getWorkspaceTree after restore");
      expect((await listedIds(ctx)).includes(ws.id), "listWorkspaces includes it again");
      expect(!(await deletedIds(ctx)).includes(ws.id), "listDeletedWorkspaces no longer has it");
      expectProblem(await ctx.client.call("restoreWorkspace", { params: { workspaceId: ws.id } }), 404, "not_found", "restoreWorkspace of a live workspace");
      expectProblem(await ctx.client.call("purgeWorkspace", { params: { workspaceId: ws.id } }), 404, "not_found", "purgeWorkspace of a live workspace");
    },
  },
  {
    id: "workspace-management.purge",
    title: "purgeWorkspace of a deleted workspace is 204; afterwards it can be neither restored nor found",
    capability: "workspace-management",
    async run(ctx) {
      const ws = ours(ctx);
      expectResponse(await ctx.client.call("deleteWorkspace", { params: { workspaceId: ws.id } }), 204, "deleteWorkspace");
      expectResponse(await ctx.client.call("purgeWorkspace", { params: { workspaceId: ws.id } }), 204, "purgeWorkspace");
      expect(!(await deletedIds(ctx)).includes(ws.id), "listDeletedWorkspaces no longer has it");
      expectProblem(await ctx.client.call("restoreWorkspace", { params: { workspaceId: ws.id } }), 404, "not_found", "restoreWorkspace after purge");
      expectProblem(await ctx.client.call("getWorkspaceTree", { params: { workspaceId: ws.id } }), 404, "not_found", "getWorkspaceTree after purge");
      made.delete(ctx);
    },
  },
];
