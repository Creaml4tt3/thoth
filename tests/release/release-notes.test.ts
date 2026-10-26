/**
 * CHANGELOG.md is the one source for the website's changelog page, each GitHub release's notes
 * (`scripts/release-notes.ts`) and the update popup's "What's new" link (`latest.json` `notes`, ADR-0022).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changelogUrl, parseChangelog, postSlug, releaseNotes, versionAnchor } from "../../scripts/changelog.ts";
import { REPO } from "../ports/harness.ts";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const SAMPLE = `# Changelog

Intro paragraph.

## [Unreleased]

### Added

- Something new.

## [0.2.0] - 2026-11-02

### Added

- A [linked](https://example.com/) thing,
  wrapped over two lines.
- Another thing.

### Fixed

- A bug.

## [0.1.0] - 2026-10-24

### Added

- The first release.

[Unreleased]: https://github.com/Creaml4tt3/thoth/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Creaml4tt3/thoth/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Creaml4tt3/thoth/releases/tag/v0.1.0
`;

describe("the changelog format", () => {
  it("reads versions, dates, sections and items (wrapped items joined), newest first", () => {
    const log = parseChangelog(SAMPLE);
    expect(log.unreleased?.sections).toEqual([{ name: "Added", items: ["Something new."] }]);
    expect(log.releases.map((r) => [r.version, r.date])).toEqual([["0.2.0", "2026-11-02"], ["0.1.0", "2026-10-24"]]);
    expect(log.releases[0]!.sections).toEqual([
      { name: "Added", items: ["A [linked](https://example.com/) thing, wrapped over two lines.", "Another thing."] },
      { name: "Fixed", items: ["A bug."] },
    ]);
    expect(log.links["0.1.0"]).toBe("https://github.com/Creaml4tt3/thoth/releases/tag/v0.1.0");
  });

  it("refuses what Keep a Changelog does not allow", () => {
    expect(() => parseChangelog(SAMPLE.replace("### Fixed", "### Bugs"))).toThrow(/Bugs/);
    expect(() => parseChangelog(SAMPLE.replace("2026-11-02", "2 Nov 2026"))).toThrow(/date/);
    expect(() => parseChangelog(SAMPLE.replace("## [0.2.0]", "## [0.2]"))).toThrow(/version/);
    // Newest first, no repeats.
    expect(() => parseChangelog(SAMPLE.replace("## [0.1.0] - 2026-10-24", "## [0.3.0] - 2026-10-24"))).toThrow(/order/);
    expect(() => parseChangelog(SAMPLE.replace("## [0.1.0]", "## [0.2.0]"))).toThrow(/order|twice/);
  });

  it("names anchors, post slugs and the changelog URL from the version", () => {
    expect(versionAnchor("0.1.3")).toBe("v0-1-3");
    expect(versionAnchor("0.2.0-beta.1")).toBe("v0-2-0-beta-1");
    expect(postSlug("0.1.3")).toBe("thoth-0-1-3");
    expect(changelogUrl("0.1.3")).toBe("https://thoth.creaml4tt3.me/changelog/#v0-1-3");
  });
});

describe("release notes for a GitHub release", () => {
  it("are that version's sections as Markdown, then links to the post, the changelog and the downloads", () => {
    expect(releaseNotes(SAMPLE, "0.2.0", { post: true })).toBe(`### Added

- A [linked](https://example.com/) thing, wrapped over two lines.
- Another thing.

### Fixed

- A bug.

[Read the post](https://thoth.creaml4tt3.me/blog/thoth-0-2-0/) · [Changelog](https://thoth.creaml4tt3.me/changelog/#v0-2-0) · [Download](https://thoth.creaml4tt3.me/#download)
`);
    // No post yet: no link to one.
    expect(releaseNotes(SAMPLE, "0.1.0", { post: false })).not.toContain("/blog/");
  });

  it("accept a tag name and refuse a version that is not released", () => {
    expect(releaseNotes(SAMPLE, "v0.1.0", { post: false })).toContain("- The first release.");
    expect(() => releaseNotes(SAMPLE, "0.9.9", { post: false })).toThrow(/0\.9\.9/);
    expect(() => releaseNotes(SAMPLE, "Unreleased", { post: false })).toThrow();
  });

  it("the script prints the notes of a real version, linking its published post", () => {
    const out = execFileSync(process.execPath, [join(REPO, "scripts", "release-notes.ts"), "v0.1.3"], { encoding: "utf8" });
    expect(out).toMatch(/^### Added\n\n- The desktop app for Windows x64/);
    expect(out).toContain("(https://thoth.creaml4tt3.me/blog/thoth-0-1-3/)");
    expect(out).toContain("(https://thoth.creaml4tt3.me/changelog/#v0-1-3)");
    expect(() => execFileSync(process.execPath, [join(REPO, "scripts", "release-notes.ts"), "9.9.9"], { stdio: "pipe" })).toThrow();
  });
});

describe("the repository's changelogs", () => {
  const en = parseChangelog(read("CHANGELOG.md"));
  const th = parseChangelog(read("CHANGELOG.th.md"));

  it("CHANGELOG.md has every tagged version, and the Thai file lists the same versions, dates and entry counts", () => {
    expect(en.releases.map((r) => r.version)).toEqual(expect.arrayContaining(["0.1.3", "0.1.2", "0.1.1", "0.1.0"]));
    expect(en.releases.find((r) => r.version === "0.1.0")?.date).toBe("2026-10-24");
    const shape = (log: typeof en) => [log.unreleased, ...log.releases].map((r) => r && { version: r.version, date: r.date, sections: r.sections.map((s) => [s.name, s.items.length]) });
    expect(shape(th)).toEqual(shape(en));
    for (const r of en.releases) expect(en.links[r.version], r.version).toMatch(/^https:\/\/github\.com\/Creaml4tt3\/thoth\//);
  });

  it("entries link only to absolute https URLs, so they read the same on GitHub and on the site", () => {
    for (const log of [en, th]) {
      for (const entry of [log.unreleased, ...log.releases]) {
        for (const item of entry?.sections.flatMap((s) => s.items) ?? []) {
          for (const m of item.matchAll(/\]\(([^)]*)\)/g)) expect(m[1], item).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it("the release workflow uses the script for the GitHub release body", () => {
    const workflow = read(".github/workflows/release-desktop.yml");
    expect(workflow).toContain('node scripts/release-notes.ts "$GITHUB_REF_NAME" > release-notes.md');
    expect(workflow).toMatch(/gh release (create|edit)[^\n]*--notes-file release-notes\.md/);
    // Only that job can write to the repository, and only for a tag.
    expect(workflow).toMatch(/github-release:[\s\S]*?if: startsWith\(github\.ref, 'refs\/tags\/v'\)[\s\S]*?permissions:\s*\n\s*contents: write/);
    expect(workflow).toMatch(/^permissions:\s*\n\s*contents: read/m);
  });
});
