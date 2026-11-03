// Keep both on a workspace page whose folder is gone or now hidden (ADR-0042): the copy lands at the top level, so
// the text the person chose to keep is never lost.
import { describe, expect, it } from "vitest";
import { ProblemError, type WorkspaceClient } from "@thoth/workspace-client";
import { problem, type PageResource } from "@thoth/workspace-protocol";
import { workspacePageStore } from "../src/workspace/workspace-store.ts";

const resource = (id: string, parentId: string | null, markdown: string): PageResource =>
  ({ id, markdown, metadata: { workspaceId: "ws", parentId, title: "Plan" }, revision: { id: `rev_${id}`, authorId: "usr_other" } }) as unknown as PageResource;

function stub(parentGone: boolean) {
  const creates: (string | null | undefined)[] = [];
  const client = {
    getPage: async () => resource("p1", "folder", "# Plan\n"),
    createPage: async (_ws: string, body: { parentId?: string | null; markdown: string }) => {
      creates.push(body.parentId);
      if (parentGone && body.parentId) throw new ProblemError(problem("not_found", { detail: "parent page not found" }));
      return resource("copy", body.parentId ?? null, body.markdown);
    },
  } as unknown as WorkspaceClient;
  const store = workspacePageStore({ client, workspace: "ws", page: "p1", role: "editor", onSaved: () => undefined });
  return { store, creates };
}

describe("workspace conflict copy", () => {
  it("is made next to the page while its folder is there", async () => {
    const { store, creates } = stub(false);
    await store.read();
    expect((await store.writeCopy("# Plan\n\nMine.\n", new Date())).ref).toBe("copy");
    expect(creates).toEqual(["folder"]);
  });

  it("falls back to the top level when the folder answers 404", async () => {
    const { store, creates } = stub(true);
    await store.read();
    expect((await store.writeCopy("# Plan\n\nMine.\n", new Date())).ref).toBe("copy");
    expect(creates).toEqual(["folder", null]);
  });
});
