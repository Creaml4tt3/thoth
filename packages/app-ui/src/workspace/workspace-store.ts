/**
 * `PageStore` for a page on a workspace server. The revision id plays the part
 * of the file hash: every write is `If-Match` on the revision the edit was based
 * on, and a 412 is the conflict.
 *
 * The protocol takes the title from the client. The server's title is kept
 * unless the user changes the page's own title in the text (frontmatter
 * `title:` or the first H1), so a page titled differently from its heading
 * (a conflict copy, a page made elsewhere) is not renamed by a save.
 */
import { ProblemError, RevisionConflict, type WorkspaceClient } from "@thoth/workspace-client";
import { roleCan, type PageResource, type Role } from "@thoth/workspace-protocol";
import type { PageStore, StoredPage } from "../editor/page-session.ts";

export interface WorkspaceStoreDeps {
  client: WorkspaceClient;
  workspace: string;
  page: string;
  role: Role;
  /** Every page this store wrote (the page itself or a conflict copy). */
  onSaved(page: PageResource): void;
}

const TITLE_MAX = 500;

/** Title for a workspace page: frontmatter `title:`, else the first `# ` heading, else `fallback`. */
export function titleFromMarkdown(markdown: string, fallback: string): string {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(markdown);
  const fmTitle = fm ? /^title:[ \t]*(.+)$/m.exec(fm[1]!)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2") : undefined;
  const body = fm ? markdown.slice(fm[0].length) : markdown;
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim();
  const title = fmTitle || heading || fallback.trim() || "Untitled";
  return title.slice(0, TITLE_MAX);
}

export function workspacePageStore(deps: WorkspaceStoreDeps): PageStore {
  const { client, workspace, page } = deps;
  const editable = roleCan(deps.role, "write");
  /** Last known title and parent (a write keeps the page where it is), and the title its text implied then. */
  let current: { title: string; parentId: string | null; implied: string } = { title: "Untitled", parentId: null, implied: "" };

  const remember = (resource: PageResource): void => {
    current = { title: resource.metadata.title, parentId: resource.metadata.parentId, implied: titleFromMarkdown(resource.markdown, "") };
  };
  const titleFor = (source: string): string => {
    const implied = titleFromMarkdown(source, "");
    return implied !== current.implied && implied !== "Untitled" ? implied : current.title;
  };

  return {
    kind: "workspace",
    async read(): Promise<StoredPage | null> {
      try {
        const resource = await client.getPage(workspace, page);
        remember(resource);
        return { source: resource.markdown, hash: resource.revision.id, editable };
      } catch (error) {
        if (error instanceof ProblemError && error.status === 404) return null;
        throw error;
      }
    },
    async write(source, expected) {
      const title = titleFor(source);
      const written = await client.putPage(workspace, page, { title, markdown: source }, expected);
      remember(written);
      deps.onSaved(written);
      return written.revision.id;
    },
    async writeCopy(source) {
      const title = `${titleFor(source)} (conflict copy)`.slice(0, TITLE_MAX);
      const created = await client.createPage(workspace, { title, markdown: source, parentId: current.parentId });
      deps.onSaved(created);
      return { ref: created.id, label: title };
    },
    isConflict: (error) => error instanceof RevisionConflict,
  };
}
