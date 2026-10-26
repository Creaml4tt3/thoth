# ADR-0026: A blog and a changelog on the website

- **Status:** Proposed
- **Date:** 2026-10-26
- **Deciders:** owner (request of 2026-10-26); to confirm

## Context

The owner asked for blog posts on the website to help search, answer and generative engines (SEO, AEO, GEO): one
post per version with its features and fixes, a changelog for each version (also in the GitHub release), and the
routes crawlers expect (sitemap, feed, llms.txt). The site is a static generator with no client-side rendering of
content (ADR-0015 rule 3), in English and Thai (rule 2). The desktop update popup already shows a "What's new" link
when `latest.json` has `notes` (ADR-0022), but nothing wrote one.

## Decision

1. **One source for the changelog.** `CHANGELOG.md` at the repository root, in Keep a Changelog 1.1.0, is the
   source of the website's changelog page, each GitHub release's body and the `notes` link in `latest.json`.
   `scripts/changelog.ts` parses it strictly (version headings, ISO dates, newest first, the six section names);
   anything else fails the build. Entries link only to absolute `https` URLs, so they read the same on GitHub.
2. **Thai changelog.** `CHANGELOG.th.md` lists the same versions, dates, sections and number of entries, written for
   Thai readers; its structural headings (`[Unreleased]`, `Added`…) stay in English and the page shows them in
   Thai. A test fails when the two files differ in shape.
3. **Release notes.** `node scripts/release-notes.ts <version>` prints the version's sections plus links to its post
   (when published), its changelog anchor and the downloads. The release workflow's `github-release` job, for tags
   only and the only job with `contents: write`, creates or edits the GitHub release with that body.
   `publish-downloads.ts` writes `notes: https://thoth.creaml4tt3.me/changelog/#v<x-y-z>` into `latest.json`.
4. **Posts.** Markdown with strict frontmatter under `apps/site/src/content/blog/{en,th}/<slug>.md`, rendered by
   the site's Markdown renderer (no raw HTML; editor comments dropped). Slug `thoth-<x-y-z>`; picture
   `/blog/images/<slug>.png` (1200×630, also the Open Graph image). Every released version has a published post in
   both languages, and every published post is a released version; `draft: true` is never built into a page, the
   sitemap, a feed or the llms files.
5. **Routes.** `/blog/`, `/blog/<slug>/`, `/changelog/` (anchor `#v0-1-3` per version, plus `#unreleased`) and the
   same under `/th/`; Atom 1.0 feeds at `/blog/feed.xml` and `/th/blog/feed.xml` with full content and absolute
   links, linked from every page's head. The sitemap lists them with `lastmod` and hreflang alternates; `llms.txt`
   has Blog and Changelog sections; `llms-full.txt` has the posts' text and both changelogs.
6. **Structured data.** A post: `BlogPosting` (author the site's Person, publisher its Organization, `about` a
   `SoftwareApplication` with `softwareVersion`), `BreadcrumbList`, and `FAQPage` only from its visible
   "Questions" block. The index: `Blog` with `blogPost`. The changelog: `WebPage` and an `ItemList` of versions.
7. **Writing.** Each post opens with a two- or three-sentence answer to "what changed in Thoth X", then short
   sections under descriptive headings, then Questions. No commit hashes, no hype words (tested).
8. **Look.** The site's existing Night theme, tokens, type, header and footer. The site has one theme by design
   (design/DESIGN.md: marketing is Night), so a light system preference shows the same page.
9. **Missing pictures.** Until a post's picture exists, the site's Open Graph card stands in (page, meta and
   JSON-LD) and the build prints a warning; it never fails on a picture.

## Consequences

- Positive: the page, the GitHub release, the feed and the update popup cannot disagree about a version.
- Positive: crawlers and answer engines get static, dated, per-version pages with matching structured data.
- Negative: each release now needs a changelog section in two languages and a post in two languages before the tag
  (docs/deploy/release.md); the build fails without them.
- Negative: two changelog files to keep in step; the test only checks their shape, not the meaning of the Thai.
- Follow-up: the orchestrator updates the existing v0.1.0–v0.1.3 GitHub releases from `release-notes.ts`; publish
  `thoth-0-2-0` with the next release; a native reader checks the Thai marked `REVIEW`.

## Alternatives considered

- **Changelog written in the site's TypeScript copy.** One fewer file, but GitHub and the release notes would need
  their own copy, which is how changelogs drift.
- **Generating the changelog from commit messages.** The commits are written for developers (internal fixes,
  tests); a person still has to choose and word the user-facing lines.
- **RSS 2.0 instead of Atom.** Both are read by every feed reader; Atom has a stricter, testable format and a
  required `updated` and `id` per entry.
- **A Thai page that shows the English changelog.** Simpler, but not written for Thai readers, which ADR-0015 rule 2
  and the brief ask for.

## Spec references

ADR-0015 (website), ADR-0022 (update notice, `notes`), docs/deploy/release.md.
