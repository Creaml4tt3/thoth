/**
 * Workspace pages as read-only agent context (ADR-0007, "Context"; ADR-0009). Pages are read with the ordinary
 * workspace client, so every request is authorized by the server. On top of that the client refuses what the server
 * would refuse for a copy out of the workspace: a workspace that is export restricted, and a role that cannot read
 * (ADR-0009: copying a page out needs read access and an unrestricted workspace). Handing a page to an AI CLI counts
 * as such a copy, because the text leaves the workspace's access control.
 *
 * The pages become files in a clearly separate read-only folder of the run's working directory (`staging.ts`);
 * nothing the agent does to them is ever written anywhere (`review.ts`).
 */
import { ProblemError, type WorkspaceClient } from "@thoth/workspace-client";
import { RoleSchema, roleCan, type Workspace } from "@thoth/workspace-protocol";

export interface WorkspacePageRef {
  /** The host's handle for the server. */
  server: string;
  workspace: string;
  page: string;
}

/** A workspace page as it was when it was read. */
export interface WorkspaceDocument {
  workspaceId: string;
  workspaceName: string;
  pageId: string;
  title: string;
  markdown: string;
  revisionId: string;
}

export type WorkspaceRefusal =
  /** The role cannot read (or is not one this app knows). */
  | "forbidden"
  /** The workspace forbids copying its content out (ADR-0009). */
  | "export_restricted"
  /** Not a member any more, or the page is gone. */
  | "not_found"
  /** The server could not be asked (signed out, offline, error). */
  | "unavailable";

export class WorkspaceContextError extends Error {
  readonly refusal: WorkspaceRefusal;
  readonly workspace: string | undefined;

  constructor(refusal: WorkspaceRefusal, message: string, workspace?: string) {
    super(message);
    this.name = "WorkspaceContextError";
    this.refusal = refusal;
    this.workspace = workspace;
  }
}

/** May pages of this workspace be given to an agent as read-only context? The role and flag are the caller's own. */
export function workspaceContextAccess(workspace: Pick<Workspace, "role" | "exportRestricted">): "allowed" | "forbidden" | "export_restricted" {
  const role = RoleSchema.safeParse(workspace.role);
  if (!role.success || !roleCan(role.data, "read")) return "forbidden";
  return workspace.exportRestricted ? "export_restricted" : "allowed";
}

export interface WorkspaceReader {
  /** The refs' pages, or a `WorkspaceContextError` naming the first refusal. Nothing is returned for a partial success. */
  readMany(refs: readonly WorkspacePageRef[]): Promise<WorkspaceDocument[]>;
}

/** A reader over `WorkspaceClient`s (the desktop gives it the directory's, which go through the host). */
export function createWorkspaceReader(clientFor: (server: string) => WorkspaceClient): WorkspaceReader {
  return {
    async readMany(refs) {
      // The membership and flags are asked fresh for every run: a role or restriction may have changed since the
      // sidebar loaded.
      const listed = new Map<string, Promise<Workspace[]>>();
      const workspacesOf = (server: string) => {
        let list = listed.get(server);
        if (!list) {
          list = clientFor(server).listWorkspaces();
          listed.set(server, list);
        }
        return list;
      };
      const docs: WorkspaceDocument[] = [];
      for (const ref of refs) {
        let workspaces: Workspace[];
        try {
          workspaces = await workspacesOf(ref.server);
        } catch (error) {
          throw new WorkspaceContextError("unavailable", error instanceof Error ? error.message : String(error));
        }
        const workspace = workspaces.find((w) => w.id === ref.workspace);
        if (!workspace) throw new WorkspaceContextError("not_found", "You are not a member of that workspace");
        const access = workspaceContextAccess(workspace);
        if (access !== "allowed") throw new WorkspaceContextError(access, access === "export_restricted" ? "This workspace does not allow its pages to be copied out" : "Your role in this workspace cannot read pages", workspace.name);
        try {
          const page = await clientFor(ref.server).getPage(workspace.id, ref.page);
          docs.push({ workspaceId: workspace.id, workspaceName: workspace.name, pageId: page.id, title: page.metadata.title, markdown: page.markdown, revisionId: page.revision.id });
        } catch (error) {
          if (error instanceof ProblemError) {
            if (error.code === "export_restricted") throw new WorkspaceContextError("export_restricted", error.message, workspace.name);
            if (error.status === 403) throw new WorkspaceContextError("forbidden", error.message, workspace.name);
            if (error.status === 404) throw new WorkspaceContextError("not_found", error.message, workspace.name);
          }
          throw new WorkspaceContextError("unavailable", error instanceof Error ? error.message : String(error), workspace.name);
        }
      }
      return docs;
    },
  };
}
