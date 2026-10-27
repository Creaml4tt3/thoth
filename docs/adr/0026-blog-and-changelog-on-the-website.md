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

## Amendment (2026-10-26): fixes from the SEO audit and the GEO review

Proposed. The audit (84/100) and the review (64/100) found the site sound but its words out of step with the released
app, and some maintainer text in public files.

1. **Unreleased work is labelled and kept apart.** On `/changelog/` the `[Unreleased]` section (still `#unreleased`)
   is headed "Coming in the next version", names no branch, carries `data-nosnippet` and comes **after** the released
   versions: readers and answer engines meet what they can download first, and a passage quoted from the top of the
   page cannot be work that has not shipped. `llms-full.txt` leaves it out, and leaves out everything before each
   changelog's first `## ` heading (the maintainer preamble). This changes rule 5's order, not its routes.
2. **The site says only what is released.** Home and FAQ claims are checked against `CHANGELOG.md`'s released
   versions (the Agent Hub, 0.1.2, is a feature) and, for the demo server, against the live trial profile (a test
   reads `TRIAL_PROFILE`). Where the code is, is one sentence chosen by `GITHUB_PUBLIC`, with no date.
3. **404.** One bilingual `404.html` at the output root, `noindex`; Vercel serves it for any missing path
   (https://vercel.com/guides/custom-404-page). One file because the host has one 404 page per deployment.
4. **Pictures.** Each blog PNG has a committed WebP (`pnpm --filter @thoth/site webp`, under 120 KB, tested), served
   through `<picture>`; the PNG stays the Open Graph image. `/blog/images/*` is cached 30 days.
5. **Dates and entity.** Sitemap `lastmod` is the real date of change (home: newest of launch, release and post);
   `SoftwareApplication` has `datePublished` (first release) and `dateModified` (newest). Person and Organization
   have descriptions; `SAME_AS` (routes.ts) is empty until the owner adds public profiles, and no `sameAs` is written
   while it is. `alternateName: "Thoth Notes"` and "local-first Markdown notes app" tell this Thoth apart.
6. **Comparison.** A Thoth / Notion / Obsidian table on the home page and in `llms-full.txt`; every Notion and
   Obsidian cell is backed by that product's documentation, listed next to the English copy, with a visible
   "checked on" date. Neutral words (tested).
7. **IndexNow.** The build writes `/<INDEXNOW_KEY>.txt` only when the variable is set; the key is never committed.
   `apps/site/scripts/indexnow.ts` posts the live sitemap's URLs after a deploy (https://www.indexnow.org/documentation).

Consequence: the comparison needs re-checking when Notion or Obsidian change; its note says when it was checked.

## Amendment (2026-10-27): the Folio layout for the blog and its posts

Proposed. The owner picked direction C ("Folio") of three mockups; it replaces the legal pages' narrow column on
`/blog/` and the posts. The changelog page and the home page's newest post keep their layout.

1. **Index.** The heading, the answer-first summary, the Changelog and feed links and a version list (number and
   date, each a link to its card's anchor, `#v0-2-0`) stay on the left, `position: sticky` inside the page grid: it
   stops at the end of the posts and never covers the footer, and is sticky only when the window is at least 961 px
   wide and 760 px tall (a sticky column taller than the window would hide its own end). On the right: the newest
   post wide, then the rest as large pictures in two columns, the right column set lower by a margin.
2. **Order.** The page and the keyboard meet the posts newest first, left then right, row by row; the offset is only
   a margin. Each card is one link: the heading's link stretches over the card, and the card draws the focus ring.
3. **Post.** The wide picture first, then the breadcrumb, a details list (version, published, author, reading time)
   and the version list on the left; the text, the release links and the older/newer links on the right. The version
   list links every post and marks this one with `aria-current="page"`.
4. **Narrow windows.** At 960 px and below one column, nothing sticky; at 640 px and below the version list is a
   compact row of version numbers (the dates stay for screen readers) above the posts or the text.
5. **`<picture>` is a block.** It had `display: contents`, so its `<source>` took a grid cell and the picture dropped
   under the words.
6. **Thai titles keep their words whole.** Chromium's line breaker split titles inside words ("ผู้|ช่วย",
   "แอปเด|สก์ท็อป"), and `word-break: keep-all` changed nothing for Thai (measured, Chromium 156). Each space-separated
   phrase of a Thai title is an inline block (`.phrase`), so titles break only at their spaces; the text is unchanged
   (search, copy, JSON-LD and feeds read the same words). A phrase wider than the line still wraps inside it.
7. **Dark only.** The mockups' light theme is not built: it would change the whole site; a later decision.

## Spec references

ADR-0015 (website), ADR-0022 (update notice, `notes`), docs/deploy/release.md.
