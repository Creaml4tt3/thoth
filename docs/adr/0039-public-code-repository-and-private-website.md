# ADR-0039: A public code repository, and the website in a private one

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** owner (rules 1, 2, 4, 5 and 6); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0015 (website and web client), ADR-0026 (blog and changelog), the release runbook (`docs/deploy/release.md`).

## Context

Thoth's code is Apache-2.0 (ADR-0011) but the repository `Creaml4tt3/thoth` is private. The owner wants the code
public and the marketing website (`apps/site`: pages, blog, pictures, showcase video) kept out of it, in its files
and in its history.

Facts on 2026-10-29:

- The repository has 397 commits on `main` and 11 release tags (`v0.1.0` to `v0.2.6`); 66 commits touch
  `apps/site`. Deleting the folder would leave every earlier version readable in the history.
- The site reads the changelogs, `docs/legal/*.md`, `scripts/changelog.ts`, `design/brand/` and `@thoth/ui`, and
  `scripts/build-website.ts` copies the web client's build into the site's `/app/`. One Vercel project (`thoth-site`)
  deploys both from `apps/site`.
- `scripts/release-notes.ts` links a version's post only when the post's file is in this repository.
- On a public repository GitHub Actions minutes are free; the private repository's macOS and Windows minutes are
  what blocked the 0.2.7 release.
- A gitleaks scan of the whole history (2026-10-29) found no secrets: 23 findings, all public keys, keyboard-shortcut
  lists and test fixtures. The real tokens on the owner's disk (`.env.local`, `.vercel/`) are git-ignored and were
  never committed.

## Decision

1. **Three repositories.** `Creaml4tt3/thoth` is the public code: desktop, web client, server, packages, protocol,
   docs. `Creaml4tt3/thoth-site` (private) is the website. Today's repository is renamed `Creaml4tt3/thoth-archive`,
   stays private and is never deleted.
2. **The public repository is new, with rewritten history.** Its history is today's, rewritten with
   `git filter-repo` so no commit holds the website or the private design work, and pushed to a new repository
   that takes the old name. A force-push into the existing repository is not used: GitHub would still show the
   old commits there.
3. **What leaves the public history** (this ADR, from rules 4 and 5): `apps/site/`, `tests/e2e/site.e2e.ts`,
   `scripts/build-website.ts`, `design/concepts/`, `design/mockups/`, `design/presentation/`, `design/research/`,
   `design/video/`, and the tooling folders `.kiro/`, `.claude/`, `.mcp.json`, `motion-audits/`, `.codegraph/`.
   The website's support-page end-to-end test moves to the site repository; the rest of `tests/e2e/feedback.e2e.ts`
   stays.
4. **What stays public:** `design/brand/` (the app, the server and `@thoth/ui` use it) and `design/DESIGN.md`. The
   design notes name their influences once and say Thoth takes a feeling from them, not their assets or code; they
   do not link to the private folders.
5. **Authorship is kept as it is:** authors and `Signed-off-by` lines keep the owner's own address, which matches
   `CONTRIBUTING.md` ("an email you can be reached at").
6. **The repositories stay as they are otherwise.** The public one remains one monorepo (client and server
   together); splitting it is not part of this decision.
7. **The site builds from the public code** (this ADR). Its build clones `Creaml4tt3/thoth` into `upstream/` at
   `THOTH_REF` (default `main`), reads the changelogs, legal pages, `scripts/changelog.ts`, `design/brand/` and
   `@thoth/ui` from there, and builds the web client into `/app/`. The pages, headers and URLs are unchanged.
8. **Release notes link a post when it is live** (this ADR). `scripts/release-notes.ts` asks
   `https://thothnotes.com/blog/thoth-<x-y-z>/` and adds the link only on a 200; any error leaves it out.
9. **A release spans both repositories** (this ADR). The code repository holds the changelog, the versions, the
   tag and the build. The site repository then publishes the post, its picture and the downloads list. The GitHub
   release job is run again once the post is live, so its notes link it.
10. **Before anything is pushed,** gitleaks scans the rewritten history. Anything other than the known false
    alarms stops the publish.

## Consequences

- Positive: the code is public with its full history, tags and authorship; the website, its blog drafts and the
  design exploration stay private. Release builds cost nothing.
- Positive: the site always builds against code anyone can read, so a self-hoster's checkout is the same code.
- Negative: every commit ID changes. Old links to commits in the private repository stop working. Release
  links by tag keep working because the tags are recreated, and the GitHub releases are recreated from the
  changelog. The installers on R2 are not touched.
- Negative: a release is two pushes in two repositories, and the GitHub release notes need a second run to pick up
  the post link.
- Negative: once public, the history cannot be taken back; clones and forks keep it.
- Follow-up: the secrets are entered again in the new repository by the owner (never in chat or files); the
  Vercel projects `thoth-api` and `thoth-site` are reconnected to their repositories; the site's
  `GITHUB_PUBLIC` is switched on. Plan: `docs/superpowers/plans/2026-10-29-split-site-from-public-repo.md`.

## Alternatives considered

- **Keep this repository private and publish a filtered mirror.** Every change would be filtered and pushed
  twice, forever, and a contribution to the mirror would have to be carried back by hand.
- **Delete `apps/site` and make this repository public.** The site stays readable in 66 earlier commits.
- **Force-push the rewritten history into this repository.** GitHub keeps showing the old commits there.
- **Separate public repositories for the client and the server.** Possible later; the packages they share
  (`domain`, `content`, `workspace-protocol`) would then need publishing, which nothing needs today.

## Spec references

None directly: the handoff does not cover where the code is hosted. ADR-0011 (licence and contributions) applies.

## Open questions

- None that block the split. Vercel's moving of a project to another repository is to be checked in its dashboard
  when it is done.
