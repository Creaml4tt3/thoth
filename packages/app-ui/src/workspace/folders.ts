/**
 * Folders in workspaces (ADR-0016 rule 3). A workspace has no folders, only pages that hold pages; a page whose
 * frontmatter says `thoth_kind: folder` is shown as a folder. These are the same rules `@thoth/transfer` uses
 * (`folderMarkdown`, `isFolderMarkdown`), kept here because the shared UI has no filesystem and so no dependency
 * on the transfer package.
 */
import { parseFrontmatter } from "@thoth/content";

export const FOLDER_KIND = "folder";

/** True for a folder page: frontmatter `thoth_kind: folder`. Malformed frontmatter is not a folder. */
export function isFolderMarkdown(markdown: string): boolean {
  const parsed = parseFrontmatter(markdown);
  return parsed.error === undefined && parsed.data["thoth_kind"] === FOLDER_KIND;
}

/** The whole Markdown of a new folder page: its identity and kind, no text of its own. */
export function folderMarkdown(id: string): string {
  return `---\nthoth_id: ${id}\nthoth_kind: ${FOLDER_KIND}\n---\n`;
}
