import { parseFrontmatter } from "@thoth/content";
import type { PageKind } from "./pages.ts";

/** The one frontmatter key a server reads (capability `page-kind`, ADR-0017). The rest of the Markdown stays opaque. */
export const PAGE_KIND_KEY = "thoth_kind";

/** The value of `thoth_kind` that makes a page a folder (ADR-0016 rule 3). */
export const FOLDER_KIND_VALUE = "folder";

/**
 * The kind of a page from its Markdown (ADR-0017 rule 3): `folder` when the frontmatter parses and `thoth_kind` is the
 * string `folder`, `page` for any other well-formed (or absent) frontmatter, and `null` (unknown) when the
 * frontmatter is malformed. Never throws, so a write can never fail because of its frontmatter.
 */
export function pageKindOf(markdown: string): PageKind | null {
  try {
    const parsed = parseFrontmatter(markdown);
    if (parsed.error !== undefined) return null;
    return parsed.data[PAGE_KIND_KEY] === FOLDER_KIND_VALUE ? "folder" : "page";
  } catch {
    return null;
  }
}
