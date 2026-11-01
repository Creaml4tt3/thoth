import { PresenceListSchema } from "@thoth/workspace-protocol";
import { createPage } from "./checks-core.ts";
import { expect, expectProblem, expectResponse, parsed, requireWorkspace, type Check } from "./support.ts";

/**
 * Capability `presence` (ADR-0041). One account can only see that it is never listed itself; seeing another member
 * needs a second account, which the reference server's own tests cover.
 */
export const presenceChecks: Check[] = [
  {
    id: "presence.heartbeat-and-leave",
    title: "heartbeatPresence answers 200 with a list that never holds the caller; leavePresence answers 204, twice; an unknown page is 404",
    capability: "presence",
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const { id, res } = await createPage(ctx, { title: `Presence ${ctx.runId}`, markdown: `# Presence ${ctx.runId}\n` });
      expectResponse(res, 201, "createPage for presence");
      const me = await ctx.client.call("getMe");
      const myId = (me.body as { id?: string } | null)?.id;
      const list = parsed(PresenceListSchema, await ctx.client.call("heartbeatPresence", { params: { workspaceId, pageId: id } }), "heartbeatPresence");
      expect(!list.items.some((e) => e.userId === myId), "the caller is listed in its own presence answer");
      for (const e of list.items) expect(Object.keys(e).every((k) => k === "userId" || k === "displayName"), "a presence entry carries more than userId and displayName");
      for (let i = 0; i < 2; i++) expectResponse(await ctx.client.call("leavePresence", { params: { workspaceId, pageId: id } }), 204, `leavePresence #${i + 1}`);
      expectProblem(await ctx.client.call("heartbeatPresence", { params: { workspaceId, pageId: "01a15cc9-7d0d-7982-a22a-e5ae3df6b019" } }), 404, "not_found", "heartbeatPresence on an unknown page");
      return `${list.items.length} other member(s) listed`;
    },
  },
];
