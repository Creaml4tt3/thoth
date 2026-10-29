# Public code repository without the marketing site — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Thoth's code (desktop, web, server, packages) as a public GitHub repository whose files and history hold none of the marketing website, while thothnotes.com keeps building from a private repository and looks the same.

**Architecture:** The website (`apps/site`, its tests, the showcase video and the design exploration) moves, with its history, to a new private repository `Creaml4tt3/thoth-site`. That repository clones the public repository into `upstream/` at build time to read the changelogs, legal text, `scripts/changelog.ts`, `@thoth/ui` and to build the web client for `/app/`. The code repository is cleaned on a branch, then its whole history is rewritten with `git filter-repo` in a fresh clone and pushed to a **new** public repository. The current private repository is kept untouched as `thoth-archive`. A new repository is used instead of force-pushing because a force-pushed public repository still exposes old commit IDs in its Activity view, and those commits stay viewable.

**Tech Stack:** git, git-filter-repo (installed at `/opt/homebrew/bin`), gitleaks (to install: `brew install gitleaks`), gh, pnpm 11, Node 24, Vite, Vitest, Playwright, Vercel.

**Spec:** the conversation of 2026-10-29: "Will marketing website push to this public repo as well? If yes I don't want that." The written spec is ADR-0039 (Task 1).

## Global Constraints

- The marketing site must not appear in any file or any commit of the public repository.
- The website and `/app/` must look and behave exactly as before (same URLs, headers and CSP from `vercel.json`).
- Secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in the `downloads` environment) are entered by the owner only, never in chat, files or logs.
- Commits: `git commit -s`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never run Prettier.
- Steps that publish or rename (Task 5) run only after the owner confirms in this conversation.
- The public repository keeps the name `Creaml4tt3/thoth`, so the existing links still work: CHANGELOG compare links, `GITHUB_REPO` in the site, and the release links.

## Owner decisions (all confirmed by the owner, 2026-10-29)

1. **Names:**
   - public `Creaml4tt3/thoth`;
   - current repository renamed to `Creaml4tt3/thoth-archive` (private, never deleted);
   - site repository `Creaml4tt3/thoth-site` (private).
2. **Design folder:** DESIGN.md is rewritten so it names its influences once and says it builds its own version, without linking the private folders (done 2026-10-29, not yet committed: `design/DESIGN.md`, `packages/ui/src/tokens.css`, `packages/app-ui/src/editor.css`, `packages/app-ui/src/ui/Button.tsx`).
   - public: `design/brand`, `design/mascot` and `design/DESIGN.md`. The app, the server and `@thoth/ui` use the first two.
   - private, moved to the site repository: `design/concepts`, `design/mockups`, `design/presentation`, `design/research` (it holds other products' screenshots) and `design/video`.
3. **Email in history:** decided (owner, 2026-10-29): keep the personal gmail address in authors and sign-offs. No rewrite. It matches CONTRIBUTING.md ("an email you can be reached at").
4. **Tooling paths in history:** removed. They are `.kiro/`, `.claude/`, `.mcp.json`, `motion-audits/` and `.codegraph/`.
5. **Separate client and server repositories:** not in this plan. The public repository stays one monorepo. Splitting it later is still possible.

## Review Focus

- **A file outside `apps/site` still imports the site** (the e2e tests, `scripts/build-website.ts`, the typecheck script, `tsconfig.json`). Expected: `pnpm check` passes in the code repository with `apps/site` gone. Task 3, Step 4.
- **Old history still holds a removed path, for example a rename.** `filter-repo --invert-paths` drops a path in every commit, but a file renamed from a kept path still survives. Expected: no commit of the public history touches any removed path. Task 4, Step 3.
- **A secret was committed and later deleted.** Expected: gitleaks finds nothing in the full rewritten history before anything is pushed. Task 4, Step 4.
- **The release notes link a post that isn't live yet.** Expected: the link appears only when `https://thothnotes.com/blog/thoth-x-y-z/` answers 200. Task 3, Step 1.
- **The site builds against a different code version than the one released.** Expected: `THOTH_REF` selects the code version, and the default is `main`. The release runbook builds the site after the tag is pushed. Task 2, Step 2.

---

### Task 1: ADR-0039, the split, in the current repository

**Files:**
- Create: `docs/adr/0039-public-code-repository-and-private-website.md` (status Proposed)
- Modify: `docs/adr/README.md` (index line)

- [ ] **Step 1:** Write the ADR. It records:
  - the decision and the three repositories;
  - the five owner decisions above;
  - why a new repository instead of a force-push (old commit IDs in Activity);
  - what the site reads from `upstream/`;
  - the new release order (Task 6);
  - the alternative not taken: a filtered public mirror kept in sync.
- [ ] **Step 2:** Add the index line. Commit `docs(adr): 0039, a public code repository and a private website`.

### Task 2: The site repository, built from the current history

Work in `/tmp/thoth-site`. Nothing is pushed in this task.

**Files (in the new repository):**
- Create (by filter-repo): the root is `apps/site`; plus `e2e/site.e2e.ts`, `e2e/support.e2e.ts`, `design/{concepts,mockups,presentation,research,video}` and `scripts/build-website.ts`.
- Create: `scripts/upstream.ts`, `.gitignore` (add `upstream/`), `playwright.config.ts`, `pnpm-lock.yaml`.
- Modify: `package.json`, `tsconfig.json`, `vercel.json`, `src/build.ts`, `src/render/blog.ts`, `src/render/seo.ts`, `src/render/mark.ts`, `src/content/blog.ts`, `scripts/og-images.ts`, `test/blog.test.ts`, `test/seo-fixes.test.ts`, `build.ts` (the `/app/` copy from `scripts/build-website.ts` moves here), `design/video/*.ts` (output paths).

**Interfaces:**
- Produces:
  - `upstream/` is the public repository checkout, at `THOTH_REF` (default `main`).
  - `REPO` constants in the site now mean `upstream/`. The site's own files are resolved from `SITE_ROOT`.

- [ ] **Step 1: Extract the history.** In a `git clone --no-local` of the current repository:
  - `git filter-repo --path apps/site/ --path tests/e2e/site.e2e.ts --path tests/e2e/feedback.e2e.ts --path scripts/build-website.ts --path design/concepts/ --path design/mockups/ --path design/presentation/ --path design/research/ --path design/video/ --path-rename apps/site/: --path-rename tests/e2e/:e2e/`
  - In `e2e/feedback.e2e.ts`, keep only the `describe("the website's support page (ADR-0033)")` block, and rename the file to `e2e/support.e2e.ts`.
- [ ] **Step 2: `scripts/upstream.ts`.**
  - If `upstream/` exists, it does nothing. For local development, that is a symlink to the code checkout.
  - Otherwise it runs `git clone --depth 1 --branch ${THOTH_REF:-main} https://github.com/Creaml4tt3/thoth upstream`.
  - Then it runs `pnpm --dir upstream install --frozen-lockfile --filter @thoth/web...`.
- [ ] **Step 3: Repoint the paths.**
  - Imports `../../../scripts/changelog.ts` (any depth) become `upstream/scripts/changelog.ts`, with the matching relative path.
  - `REPO` in `src/build.ts` and `scripts/og-images.ts`, and the `design/brand` paths in `src/render/mark.ts`, point to `upstream/`.
  - `package.json`:
    - `"@thoth/ui": "link:upstream/packages/ui"`;
    - drop `private` workspace assumptions;
    - add `@playwright/test` and `@axe-core/playwright` at the versions in the code repository's root `package.json`.
  - `tsconfig.json` extends `./upstream/tsconfig.base.json`.
  - `build.ts` builds the site, then runs `pnpm --dir upstream --filter ./apps/web build` and copies `upstream/apps/web/dist` to `dist/app`.
  - `vercel.json`:
    - `installCommand: "node scripts/upstream.ts && corepack enable && pnpm install --frozen-lockfile"`;
    - `buildCommand: "pnpm build"`;
    - everything else unchanged.
- [ ] **Step 4: Verify locally**, with `ln -s /Users/user/Desktop/Creaml4tt3/thoth upstream`:
  - `pnpm install && pnpm exec tsc -p tsconfig.json`: no errors.
  - `pnpm exec vitest run`: the same count the code repository runs today for `apps/site/test` (153).
  - `pnpm build`: `dist/index.html` and `dist/app/index.html` exist.
  - `diff -r` against `pnpm build:website` output from the code repository: no differences except hashed asset names.
  - `pnpm exec playwright test`: site and support e2e pass. The support test needs Podman, as today.
- [ ] **Step 5: Commit** `chore: the website as its own repository, reading the code from upstream/`.

### Task 3: The code repository without the site

Work on branch `split/no-site` in the current repository. It runs in parallel with Task 2.

**Files:**
- Delete:
  - `apps/site/`, `scripts/build-website.ts` and `tests/e2e/site.e2e.ts`;
  - `design/{concepts,mockups,presentation,research,video}`;
  - the support-page `describe` in `tests/e2e/feedback.e2e.ts` and its site imports.
- Modify:
  - `scripts/release-notes.ts` and `tests/release/release-notes.test.ts`;
  - `package.json` (`typecheck` without `apps/site`; drop the `build:website`, `video` and `video:record` scripts);
  - `tsconfig.json` (drop `apps/site/**`);
  - `pnpm-lock.yaml` (`pnpm install`);
  - `.gitignore` (drop the video lines);
  - `README.md`;
  - `docs/deploy/release.md`, `docs/deploy/trial.md` §6;
  - the comment in `apps/web/vite.config.ts`;
  - the `> apps/site publishes this file` notes in `docs/legal/*.md`: say "the website publishes".
- Keep: `scripts/changelog.ts` (`SITE_ORIGIN`, `postUrl`), `packages/ui`, `design/brand`, `design/mascot`, `design/DESIGN.md`. Older ADRs stay as written.

**Interfaces:**
- Produces:
  - `postPublished(version: string, fetcher: typeof fetch = fetch): Promise<boolean>`, which is true only when `HEAD postUrl(version)` answers 200;
  - CLI `node scripts/release-notes.ts <version> [--no-post]`.

- [ ] **Step 1: Write the failing tests** in `tests/release/release-notes.test.ts`:
  ```ts
  it("links the post only when it is live", async () => {
    const answer = (status: number) => (async () => new Response(null, { status })) as typeof fetch;
    expect(await postPublished("0.2.6", answer(200))).toBe(true);
    expect(await postPublished("v0.2.6", answer(404))).toBe(false);
    expect(await postPublished("0.2.6", (async () => { throw new TypeError("offline"); }) as typeof fetch)).toBe(false);
  });
  ```
  The existing CLI test at line 99 runs with `--no-post` and no longer expects the post link.
- [ ] **Step 2:** Run `pnpm vitest run tests/release/release-notes.test.ts`. It FAILS, because `postPublished` reads a file and is synchronous.
- [ ] **Step 3:** Implement Step 1's interface:
  - `fetch(postUrl(v), { method: "HEAD", redirect: "follow" })`;
  - any error gives false;
  - the CLI awaits it, unless `--no-post` is given.
- [ ] **Step 4:** Delete and edit everything in **Files**, then run `pnpm check`. Expected: typecheck, schemas, openapi and vitest all pass. `git grep -n "apps/site\|@thoth/site\|build-website\|design/video"` matches only `docs/adr/` and `docs/architecture/implementation-plan.md`, which are history and stay.
- [ ] **Step 5:** Run `pnpm e2e`. Expected: everything passes except the known flaky `sidebar-dnd` pair; rerun those alone.
- [ ] **Step 6:** Make two commits:
  - `feat(release): link the post when it is live, not when its file is here`;
  - `chore: the website and its design work leave this repository (ADR-0039)`.

### Task 4: The public history, in a fresh clone

Needs Tasks 1 and 3 merged to local `main`, and the owner's answers to decisions 2–4.

- [ ] **Step 1: Back up first:**
  - Push the current `main` (including 45c7fbc, cba2d21 and the new commits) and all tags to the private repository.
  - Then run `git clone --mirror https://github.com/Creaml4tt3/thoth /tmp/thoth-backup.git`.
- [ ] **Step 2: Rewrite**, in `git clone --no-local <repo> /tmp/thoth-public`:
  - `git filter-repo --invert-paths` with:
    - `--path apps/site/ --path tests/e2e/site.e2e.ts --path scripts/build-website.ts`;
    - `--path design/concepts/ --path design/mockups/ --path design/presentation/ --path design/research/ --path design/video/`;
    - `--path .kiro/ --path .claude/ --path .mcp.json --path motion-audits/ --path .codegraph/`.
  - `tests/e2e/feedback.e2e.ts` keeps its history. Its old versions held the support-page test, which is test code, not the site.
- [ ] **Step 3: Check the paths.**
  - `git log --all --format= --name-only | sort -u | grep -E '^(apps/site|design/(concepts|mockups|presentation|research|video)|\.kiro|\.claude|\.mcp\.json|motion-audits|\.codegraph)|site\.e2e|build-website'` prints nothing.
  - `git diff <local main> HEAD --stat` is empty: the final tree is unchanged.
- [ ] **Step 4: Scan for secrets.** Run `gitleaks git /tmp/thoth-public --log-opts=--all --redact --report-format json --report-path /tmp/gl.json`. The 2026-10-29 scan of the full private history found 23 findings, all false alarms, all `generic-api-key`:
  - the updater's public key (`tauri.conf.json`, `pubkey`);
  - keyboard-shortcut lists (`KEYS =` in `SidebarSections.tsx` and `FavoritesList.tsx`);
  - test fixtures: `secrets.test.ts`, `trial.test.ts`, the Rust `remote/mod.rs` token tests, and `tests/protocol/samples.ts`;
  - `apps/site/test/seo-fixes.test.ts`, which is removed by the rewrite.

  Anything else in a different file or under a different rule means stop. Report only the file and the rule, never the value.
- [ ] **Step 5:** Check that all 11 tags (`v0.1.0`–`v0.2.6`) exist and that `pnpm install && pnpm check` passes in `/tmp/thoth-public`.

### Task 5: Publish (owner confirms first; cannot be undone once public)

- [ ] **Step 1:** Rename the private repository to `thoth-archive`: `gh repo rename thoth-archive -R Creaml4tt3/thoth`. The Vercel project `thoth-site` follows the repository ID, so the website keeps deploying from the archive during the switch.
- [ ] **Step 2:** `gh repo create Creaml4tt3/thoth --public --description "…"`. From `/tmp/thoth-public`, run `git push origin main --tags`.
- [ ] **Step 3: The owner enters the secrets** in the new repository:
  - `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/thoth-updater.key` and `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
  - environment `downloads` with the three R2 secrets.
  - I check only the names: `gh secret list`, `gh api …/environments/downloads/secrets --jq '.secrets[].name'`.
- [ ] **Step 4:** Recreate the 11 GitHub releases. For each tag: `node scripts/release-notes.ts <tag> > n.md && gh release create <tag> --verify-tag --title "Thoth <v>" --notes-file n.md`. Their files are on R2, so there is nothing to upload.
- [ ] **Step 5:** Vercel:
  - Move the `thoth-api` project's Git connection to the new `Creaml4tt3/thoth`, with root `apps/server` as today.
  - Create the private repository `thoth-site`, push Task 2's result, and connect the `thoth-site` project to it, with root directory `.`.
  - Check that `https://thothnotes.com/`, `/app/`, `/changelog/` and `/blog/thoth-0-2-6/` answer 200 with the same CSP header as before.
- [ ] **Step 6:** In `thoth-site`, set `GITHUB_PUBLIC = true` in `src/routes.ts`, update the expectations in `test/` and commit.
- [ ] **Step 7:** Re-clone the working copy: `git clone https://github.com/Creaml4tt3/thoth`. The old local folder points at the archive. Update memory `thoth-deploy-setup.md`.

### Task 6: Release runbook for two repositories, proven by 0.2.7

**Files:**
- Modify: `docs/deploy/release.md` in the code repository (the code steps), and add `RELEASING.md` in `thoth-site` (the website steps).

- [ ] **Step 1:** Split the runbook.
  - Code repository:
    - changelogs;
    - versions;
    - tag;
    - the workflow (now free on a public repository; run the `main` warm-up first so the Rust cache is used).
  - Site repository, after the workflow has passed:
    - publish the post and its picture;
    - copy `latest.json` into `src/content/downloads.ts`;
    - push (Vercel deploys);
    - IndexNow.
  - Then rerun the `github-release` job, so the notes pick up the live post link: `gh run rerun <id> --job <github-release>`.
- [ ] **Step 2:** Release 0.2.7 by that runbook, using the steps from the previous plan (memory `thoth-0-2-7-plan.md`). Expected: the workflow is green, and `https://download.thothnotes.com/latest.json` says `0.2.7`. The GitHub release links `https://thothnotes.com/blog/thoth-0-2-7/`.
