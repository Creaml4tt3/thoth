/**
 * `node scripts/release-notes.ts <version> [--no-post]`: prints that version's section of CHANGELOG.md as Markdown,
 * for the body of its GitHub release (.github/workflows/release-desktop.yml). `v0.1.3` and `0.1.3` both work.
 *
 * The post link is added only when the website serves the version's post (ADR-0039: the posts live in the website's
 * own repository). `--no-post` leaves it out without asking.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { postUrl, releaseNotes } from "./changelog.ts";

const REPO = join(import.meta.dirname, "..");

/** Whether the website serves the version's English post: 200 after redirects; any error is "no". */
export async function postPublished(version: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(postUrl(version.replace(/^v/, "")), { method: "HEAD", redirect: "follow" });
    return response.status === 200;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const [version, flag] = process.argv.slice(2);
  try {
    if (!version || (flag !== undefined && flag !== "--no-post")) throw new Error("usage: node scripts/release-notes.ts <version> [--no-post]");
    const post = flag === "--no-post" ? false : await postPublished(version);
    process.stdout.write(releaseNotes(readFileSync(join(REPO, "CHANGELOG.md"), "utf8"), version, { post }));
  } catch (error) {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
