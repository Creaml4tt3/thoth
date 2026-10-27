/**
 * CHANGELOG.md (Keep a Changelog 1.1.0): parsed for the website's changelog page (apps/site), the GitHub release
 * notes (`scripts/release-notes.ts`) and the `notes` link in `latest.json` (`scripts/publish-downloads.ts`).
 *
 * The format, strictly:
 *
 *   ## [Unreleased]                 optional, first
 *   ## [0.1.3] - 2026-10-25         semantic version and ISO date, newest first, each once
 *   ### Added | Changed | Deprecated | Removed | Fixed | Security
 *   - one entry (a wrapped line continues it)
 *   [0.1.3]: https://...            link definitions at the end
 *
 * Anything else under a version is an error, so a typo cannot drop entries from the page or the release notes.
 */

/** The website; the changelog page and the posts are published there. */
export const SITE_ORIGIN = "https://thothnotes.com";

export const SECTION_NAMES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export interface ChangelogSection {
  name: SectionName;
  /** Each entry's Markdown, without the leading "- "; wrapped lines are joined with a space. */
  items: string[];
}

export interface ChangelogEntry {
  /** A semantic version, or "Unreleased". */
  version: string;
  /** `yyyy-mm-dd`; null for Unreleased. */
  date: string | null;
  sections: ChangelogSection[];
}

export interface Changelog {
  /** The paragraphs between the title and the first version, as Markdown. */
  intro: string[];
  unreleased: ChangelogEntry | null;
  /** Newest first. */
  releases: ChangelogEntry[];
  /** Link definitions by label (`0.1.3`, `Unreleased`). */
  links: Record<string, string>;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_HEADING = /^## \[([^\]]+)\](?: - (.+))?$/;
const LINK_DEF = /^\[([^\]]+)\]:\s*(\S+)$/;

export function parseChangelog(source: string): Changelog {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const intro: string[] = [];
  const entries: ChangelogEntry[] = [];
  const links: Record<string, string> = {};
  let entry: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;
  let paragraph: string[] = [];
  let sawTitle = false;

  const fail = (n: number, message: string): never => {
    throw new Error(`CHANGELOG line ${n + 1}: ${message}`);
  };

  lines.forEach((line, n) => {
    // Notes for editors (`<!-- REVIEW -->`) are not part of the changelog.
    if (/^\s*<!--.*-->\s*$/.test(line)) return;
    const link = LINK_DEF.exec(line);
    if (link) {
      links[link[1]!] = link[2]!;
      return;
    }
    if (line.startsWith("# ")) {
      if (sawTitle || entry) fail(n, "only one level-1 heading");
      sawTitle = true;
      return;
    }
    const version = VERSION_HEADING.exec(line);
    if (line.startsWith("## ")) {
      if (!version) fail(n, `a version heading is "## [x.y.z] - yyyy-mm-dd", not "${line}"`);
      if (paragraph.length) intro.push(paragraph.join(" "));
      paragraph = [];
      const [, name, date] = version!;
      if (name === "Unreleased") {
        if (entries.length > 0) fail(n, "Unreleased comes first");
        if (date) fail(n, "Unreleased has no date");
        entry = { version: "Unreleased", date: null, sections: [] };
      } else {
        if (!SEMVER.test(name!)) fail(n, `"${name}" is not a semantic version`);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail(n, `${name} needs a date as yyyy-mm-dd`);
        const previous = entries.filter((e) => e.version !== "Unreleased").at(-1);
        if (entries.some((e) => e.version === name)) fail(n, `${name} is listed twice`);
        if (previous && compareVersions(name!, previous.version) >= 0) fail(n, `${name} is out of order: newest first`);
        entry = { version: name!, date: date!, sections: [] };
      }
      entries.push(entry);
      section = null;
      return;
    }
    if (line.startsWith("### ")) {
      if (!entry) fail(n, "a section heading before any version");
      const name = line.slice(4).trim();
      if (!(SECTION_NAMES as readonly string[]).includes(name)) fail(n, `"${name}" is not a Keep a Changelog section (${SECTION_NAMES.join(", ")})`);
      if (entry!.sections.some((s) => s.name === name)) fail(n, `${name} appears twice in ${entry!.version}`);
      section = { name: name as SectionName, items: [] };
      entry!.sections.push(section);
      return;
    }
    if (line.startsWith("- ")) {
      if (!section) fail(n, "an entry outside a section");
      section!.items.push(line.slice(2).trim());
      return;
    }
    if (line.trim() === "") {
      if (!entry && paragraph.length) {
        intro.push(paragraph.join(" "));
        paragraph = [];
      }
      return;
    }
    if (/^\s+\S/.test(line) && section && section.items.length > 0) {
      section.items[section.items.length - 1] += ` ${line.trim()}`;
      return;
    }
    if (!entry) {
      paragraph.push(line.trim());
      return;
    }
    fail(n, `unexpected text under ${entry.version}: "${line}"`);
  });
  if (paragraph.length) intro.push(paragraph.join(" "));
  for (const e of entries) if (e.sections.length === 0 || e.sections.some((s) => s.items.length === 0)) throw new Error(`CHANGELOG: ${e.version} has an empty section`);

  const unreleased = entries[0]?.version === "Unreleased" ? entries[0] : null;
  return { intro, unreleased, releases: entries.filter((e) => e !== unreleased), links };
}

/** Compares two semantic versions (a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split("-", 2) as [string, string | undefined];
    return { nums: core.split(".").map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const dashed = (version: string) => version.replace(/[^0-9A-Za-z]+/g, "-");

/** The changelog page's anchor for a version: `0.1.3` → `v0-1-3`. */
export function versionAnchor(version: string): string {
  return `v${dashed(version)}`;
}

/** The blog post for a version: `0.1.3` → `thoth-0-1-3`. */
export function postSlug(version: string): string {
  return `thoth-${dashed(version)}`;
}

export function changelogUrl(version: string, site = SITE_ORIGIN): string {
  return `${site}/changelog/#${versionAnchor(version)}`;
}

export function postUrl(version: string, site = SITE_ORIGIN): string {
  return `${site}/blog/${postSlug(version)}/`;
}

/** A version's sections as Markdown, then links to its post (when published), the changelog and the downloads. */
export function releaseNotes(source: string, version: string, options: { post: boolean; site?: string }): string {
  const wanted = version.replace(/^v/, "");
  const entry = parseChangelog(source).releases.find((r) => r.version === wanted);
  if (!entry) throw new Error(`CHANGELOG.md has no released version ${wanted}`);
  const site = options.site ?? SITE_ORIGIN;
  const body = entry.sections.map((s) => `### ${s.name}\n\n${s.items.map((i) => `- ${i}`).join("\n")}\n`).join("\n");
  const links = [
    ...(options.post ? [`[Read the post](${postUrl(wanted, site)})`] : []),
    `[Changelog](${changelogUrl(wanted, site)})`,
    `[Download](${site}/#download)`,
  ];
  return `${body}\n${links.join(" · ")}\n`;
}
