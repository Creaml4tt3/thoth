/**
 * `node scripts/release-notes.ts <version>`: prints that version's section of CHANGELOG.md as Markdown, for the body
 * of its GitHub release (.github/workflows/release-desktop.yml). `v0.1.3` and `0.1.3` both work.
 *
 * The post link is added only when the version's blog post exists and is not a draft
 * (apps/site/src/content/blog/en/thoth-<x-y-z>.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { postSlug, releaseNotes } from "./changelog.ts";

const REPO = join(import.meta.dirname, "..");

/** Whether the English post for a version is published (exists, and its frontmatter has no `draft: true`). */
export function postPublished(version: string, repo = REPO): boolean {
  const file = join(repo, "apps", "site", "src", "content", "blog", "en", `${postSlug(version.replace(/^v/, ""))}.md`);
  if (!existsSync(file)) return false;
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  return !/^draft:\s*true\s*$/m.test(frontmatter);
}

if (import.meta.main) {
  const version = process.argv[2];
  try {
    if (!version) throw new Error("usage: node scripts/release-notes.ts <version>");
    process.stdout.write(releaseNotes(readFileSync(join(REPO, "CHANGELOG.md"), "utf8"), version, { post: postPublished(version) }));
  } catch (error) {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
