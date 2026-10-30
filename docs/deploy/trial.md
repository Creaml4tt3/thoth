# Deploying the hosted trial (Vercel + Neon)

This is the checklist for the owner to set up the trial described in ADR-0014.
Every secret goes into the provider's dashboard or a password manager, never
into this repository, a chat or a terminal log.

Domains used below (change them when you buy your own domain):

| What | Address |
| --- | --- |
| Website (the private `thoth-site` repository, with `apps/web` at `/app/`; ADR-0039) | `https://thothnotes.com` |
| API (`apps/server`) | `https://api.thothnotes.com` |

> Status (2026-10-24): every step is done and live. The Neon project is
> `thoth`; the Vercel projects `thoth-api` and `thoth-site` are connected to
> the GitHub repository `Creaml4tt3/thoth` and deploy on every push to
> `main`.

## 1. Database: Neon (free plan)

1. Create a Neon project. Pick the region nearest your users, for example
   **AWS Asia Pacific (Singapore)**. The region cannot be changed later.
2. In **Connect**, copy two connection strings into your password manager:
   - **pooled** (host contains `-pooler`): the API uses this one;
   - **direct** (pooling off): only for running migrations.
3. Run the migrations once from your computer, and again after each server
   update that adds a migration. Read the direct URL from your password
   manager into the shell without echoing it:

   ```sh
   read -rs DATABASE_URL && export DATABASE_URL   # paste the direct URL, press Enter
   node apps/server/src/cli.ts migrate
   unset DATABASE_URL
   ```

   Migration `009_page_kind.sql` (ADR-0017) only adds empty columns, because SQL
   cannot read Markdown. `migrate` prints a hint when it applies it. Right
   after that migration, and once only, fill in the page kind of the pages
   written before it, so that existing folders show as folders. It is safe to
   run while the API is serving, and safe to repeat:

   ```sh
   read -rs DATABASE_URL && export DATABASE_URL   # the direct URL again
   node apps/server/src/cli.ts backfill-kind      # optional: --batch <n>, 1 to 1000, default 200
   unset DATABASE_URL
   ```

   It prints the counts as JSON, for example
   `{"pages":{"scanned":42,"updated":41,"unknown":1},"changes":{...}}`. `unknown`
   counts pages whose frontmatter is malformed: they have no kind and show as
   pages. Until the backfill has run, an older folder shows as a page; new and
   edited pages are correct at once.

   On macOS, `scripts/prod-db.sh migrate backfill-kind` does the same through a private dialog (hidden
   input; the URL is kept in memory only, redacted from output and not saved). It accepts only `migrate` and
   `backfill-kind` and refuses the pooled URL.

   Migration `010_share_links.sql` (ADR-0023, public share links) adds one new
   table and needs no backfill. **Apply it to Neon before you deploy the server
   build that contains it.** That build lists the capability `public-share`, so
   the apps offer "Share…" right away. Without the table, every share call and
   every `/s/<token>` page fails with a database error.

   Migration `011_invites.sql` (ADR-0024, members and invite links) adds two
   tables (`invite_links`, `invite_tickets`) and one nullable column
   (`auth_requests.invite_id`) and needs no backfill. It is additive and safe
   while the old build runs. **Apply it to Neon before you deploy the server
   build that contains it.** That build lists `members` and `invite-links`, so
   the apps offer "Members…" and invite links right away; without the tables
   every invite call and `/i/<token>` page fails with a database error.

   Migration `012_workspace_deletion.sql` (ADR-0025, several workspaces per
   account) adds two nullable columns (`workspaces.deleted_at`,
   `workspaces.deleted_by`) and a partial index, and needs no backfill. It is
   additive and safe while the old build runs. **Apply it to Neon before you
   deploy the server build that contains it.** That build lists
   `workspace-management`, so the apps offer "New workspace…", Rename… and
   Delete… right away; without the columns every workspace route fails with a
   database error.

   Migration `013_feedback.sql` (ADR-0033, feedback from users) adds two
   tables (`feedback`, `feedback_settings` with a random salt) and needs no
   backfill. It is additive and safe while the old build runs. **Apply it to
   Neon before you deploy the server build that contains it.** That build lists
   `feedback`, so the apps and the website's support page send to it right away;
   without the tables every feedback request fails with a database error. The
   website's form posts from the site's origin, which must stay in
   `CORS_ORIGINS`.

   Migration `014_feedback_diagnostics.sql` (ADR-0040, the app log in
   feedback) adds one nullable column (`feedback.diagnostics jsonb`) and needs
   no backfill. It is additive and safe while the old build runs. **Apply it to
   Neon before you deploy the server build that contains it.** That build's
   `storeFeedback` and `listFeedback` name the column, so without it every
   feedback request (with or without a log) and `feedback list` fail with a
   database error.

Free-plan facts to keep in mind:
- 1 GB of storage.
- 100 compute-hours a month.
- The database sleeps after 5 minutes idle, so the first request after a quiet
  period takes a moment longer.

## 2. DNS for `thothnotes.com`

At your DNS provider, add a record for each host (ADR-0031):

| Name | Type | Value |
| --- | --- | --- |
| `@` (the apex, `thothnotes.com`) | A / ALIAS | the target Vercel shows when you add the domain |
| `www` | CNAME | the target Vercel shows; in Vercel, redirect it to `thothnotes.com` |
| `api` | CNAME | the target Vercel shows when you add the domain to the API project |
| `download` | CNAME | the R2 custom domain (docs/deploy/release.md) |

Keep the website and the API under the same parent domain. Two `*.vercel.app`
names do not work for sign-in cookies.

The old hosts stay up (ADR-0031): `thoth.creaml4tt3.me` answers with a 301 to
`https://thothnotes.com` (a Vercel redirect, not a second deployment), and
`api.thoth.creaml4tt3.me` stays on the API project, because installed apps
have it saved as a server. Add it to the API project's domains and keep it in
`CORS_ORIGINS` only if a page on the old host still calls the API (the
redirect means none does).

## 3. API project on Vercel

1. Create a Vercel project connected to the repository, with root directory
   `apps/server`, no framework, Node 24, and "Include files outside the root
   directory" on. Settings:
   - Install: `cd ../.. && corepack enable && pnpm install --frozen-lockfile --filter @thoth/server...`
   - Build: `pnpm build:vercel`

   `apps/server/scripts/build-vercel.ts` bundles `src/vercel.ts` into
   `apps/server/.vercel/output` (Build Output API v3: one Node 24 function in
   region `sin1`, every path routed to it, and the daily cron below), which
   Vercel deploys as is. Every push to `main` deploys it. To deploy from your
   computer instead: `vercel link --project thoth-api`, `pnpm build:vercel`,
   `vercel deploy --prebuilt --prod` (from `apps/server`).

   The function refuses to start unless `MIGRATE_ON_START=false` and events
   are off (the trial profile turns them off). Until it can start it answers
   `503 service_unavailable` and tries again on the next request.
2. The function region is `sin1`, next to the Neon region (Singapore). It is
   set by the build.
3. Add the domain `api.thothnotes.com`.
4. Environment variables (Production). Enter the values in the Vercel
   dashboard only:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon **pooled** URL |
   | `THOTH_PROFILE` | `trial` (sets the limits, the 300-account cap, rate limits and `EVENTS=off`) |
   | `MIGRATE_ON_START` | `false` |
   | `TRUST_PROXY` | `true` (Vercel sets the client IP header) |
   | `CORS_ORIGINS` | `https://thothnotes.com` |
   | `CRON_SECRET` | a long random value, e.g. from `openssl rand -base64 32`; Vercel Cron sends it automatically |
   | `PUBLIC_URL` | `https://api.thothnotes.com` (the sign-in redirect addresses are built from it) |
   | `SERVER_NAME` | `Thoth demo server` (the name the desktop app and web client show; the same as the starter server's name) |
   | `WEB_REDIRECT_URIS` | `https://thothnotes.com/app/callback` |

   Public share links (ADR-0023) are on in the trial with no extra variable.
   `THOTH_PROFILE=trial` sets these defaults, and each one can be overridden:

   | Variable | Trial default | Meaning |
   | --- | --- | --- |
   | `PUBLIC_SHARE` | `on` | `off` hides "Share…" in the apps, answers the share calls `501`, and makes every `/s/<token>` address the not-found page |
   | `MAX_SHARE_LINKS_PER_WORKSPACE` | `20` | Active (not revoked, not expired) links per workspace. One more is `409 quota_exceeded` (`quota: shareLinksPerWorkspace`) |
   | `SHARE_VIEWS_PER_LINK` | `300` | Requests per link (pages and pictures) per `RATE_LIMIT_WINDOW_SECONDS` (60). Counted per token, known or not |
   | `SHARE_VIEWS_PER_IP` | `120` | Requests to any shared page per client IP per window. Needs `TRUST_PROXY=true` behind Vercel |

   Share addresses are built from `PUBLIC_URL`
   (`https://api.thothnotes.com/s/<token>`). The pages are served by the
   same function as the API.

   Members and invite links (ADR-0024) are on in the trial with no extra
   variable. Members management has no switch; the trial keeps the 10-member
   limit (`MAX_MEMBERS_PER_WORKSPACE`), and an invite link never offers more
   uses than that leaves room for:

   | Variable | Trial default | Meaning |
   | --- | --- | --- |
   | `INVITE_LINKS` | `on` | `off` hides invite links in the apps, answers the invite calls `501`, and makes every `/i/<token>` address the not-found page |
   | `MAX_INVITE_LINKS_PER_WORKSPACE` | `20` | Active (not revoked, not expired, not used up) links per workspace. One more is `409 quota_exceeded` (`quota: inviteLinksPerWorkspace`) |
   | `INVITE_OPENS_PER_IP` | `60` | Invite pages opened per client IP per window (every server, not only the trial). Needs `TRUST_PROXY=true` behind Vercel |
   | `INVITE_ACCEPTS_PER_IP` | `20` | Joins per client IP per window, counted before the token is looked up |

   Invite addresses are `https://api.thothnotes.com/i/<token>`. "Sign in
   to join" uses the Google and GitHub providers already registered: the
   callback addresses (`/auth/callback/google`, `/auth/callback/github`) do not
   change. After joining, "Open in Thoth" goes to the web client, derived from
   `WEB_REDIRECT_URIS` (`https://thothnotes.com/app/`).

   Several workspaces per account (ADR-0025) are on in the trial. The trial
   profile now lets an account own **3** workspaces (it was 1). Deleted
   workspaces count until they are purged (after 30 days by the daily cron
   job, or at once with "Delete permanently"):

   | Variable | Trial default | Meaning |
   | --- | --- | --- |
   | `MAX_WORKSPACES_PER_ACCOUNT` | `3` | Owned workspaces per account. **If the Vercel project sets this variable (for example to `1` from the first launch), it overrides the profile: change it to `3`, or delete it.** One more is `409 quota_exceeded` (`quota: workspacesPerAccount`) |
   | `MAX_WORKSPACE_CREATIONS_PER_DAY` | `10` | Workspaces one account may create per UTC day through the API. One more is `409 quota_exceeded` (`quota: workspaceCreationsPerDay`) |
   | `WORKSPACE_MANAGEMENT` | `on` | `off` hides New workspace, Rename… and Delete… in the apps and answers those calls `501` |

5. The daily cron job that calls `/internal/maintenance` is part of the build
   (`0 20 * * *` UTC, 03:00 in Thailand). The Hobby plan allows once a day.

## 4. Google sign-in (first provider)

1. In Google Cloud Console, create a project, then **Google Auth Platform →
   Branding**:
   - app name;
   - support email;
   - links to the published privacy notice and terms (`docs/legal/`);
   - authorized domain `thothnotes.com`.
2. **Audience**: External. Scopes: `openid`, `email`, `profile` only. These are
   non-sensitive, so no Google verification review is needed.
3. **Clients → Create client → Web application**, with:
   - Authorized redirect URI: `https://api.thothnotes.com/auth/callback/google`
   - No JavaScript origins needed: the browser never talks to Google directly.
4. Put the client ID and client secret into the API project's environment
   variables: `OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET`.
5. Publish the app (Testing mode only allows listed test users).

## 5. GitHub sign-in (second provider)

1. GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**, with:
   - Homepage URL: `https://thothnotes.com`
   - Authorization callback URL: `https://api.thothnotes.com/auth/callback/github`
2. Generate a client secret and put both values into the API project's
   environment variables: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
3. The server asks only for `read:user` and `user:email`.

## 6. Website project

The website at `thothnotes.com` is **one static deployment** made of two
builds (ADR-0015): the pages, blog and changelog from the website's own private
repository (`Creaml4tt3/thoth-site`, ADR-0039), and the web client from
`apps/web` in this repository, served at `/app/`.

The website's build clones this repository and reads from it:
- `CHANGELOG.md` and `CHANGELOG.th.md`, through `scripts/changelog.ts`;
- the privacy and terms pages in `docs/legal/`;
- `design/brand/` and `@thoth/ui` (`packages/ui`);
- `apps/web`, which it builds into its `/app/`.

Its Vercel project (`thoth-site`), its headers, its Content Security Policy and
its environment variables are described in that repository.

1. Create the website's Vercel project from the website's repository. Besides the pages, it serves `/app/` and must:
   - leave `/app/` out of the site's Content Security Policy, so the web client
     sends its own (its `connect-src` needs the trial API);
   - send `X-Robots-Tag: noindex` on `/app/` (`robots.txt` also disallows it);
   - rewrite `/app/*` to `/app/index.html` for the web client's routes.
2. Add the domain `thothnotes.com`.
3. Environment variables (Production), in the Vercel dashboard only:

   | Variable | Value |
   | --- | --- |
   | `VITE_GA4_ID` | the GA4 measurement ID (`G-…`). Leave unset for no analytics code at all |
   | `VITE_DEFAULT_SERVER` | `https://api.thothnotes.com` (read by the web client's build) |

   The website's own variables are listed in its repository.

4. In Google Analytics (property settings):
   - **Data retention**: 2 months, to match the privacy notice;
   - **Google signals**: off; ads personalisation: off;
   - no user ID, no User-Provided Data collection.
5. Check after the first deploy:
   - `/`, `/th/`, `/privacy/` and `/app/` load;
   - before you choose in the cookie banner, the browser's network panel shows
     no request to Google;
   - `https://thothnotes.com/sitemap.xml` and `/robots.txt` load. Submit
     the sitemap in Google Search Console.

The web client connects only to this trial server (owner, 2026-10-24): its
server address is fixed at build time (`VITE_DEFAULT_SERVER`), and it has no
"connect to another server" field. Self-hosters use the desktop app, or host
the web client themselves. The web client sends analytics through the site's
`/analytics.js` (`window.thothAnalytics.track`), so the one consent choice
covers both.

The web client is built with `pnpm --filter @thoth/web build` into
`apps/web/dist`, for the path `/app/` (the site's deploy puts it there). The
static host must:
- serve `index.html` for `/app/callback` (and any other `/app/` path without a
  file extension);
- send the Content-Security-Policy of `apps/web/index.html` as a response
  header too, because browsers ignore `frame-ancestors` in a `<meta>` tag.

The desktop app suggests this server as its starter server (Settings →
Servers), with a short caution. The address is in
`packages/app-ui/src/workspace/starter.ts`.

## Before the trial goes public

- [ ] The privacy notice and terms (`docs/legal/`, English and Thai) have been
      reviewed by someone who knows Thai PDPA, and the `OWNER:` comments in
      them are resolved (log retention matches your Vercel plan; GA4 data
      retention is 2 months). The site publishes them at `/privacy/`,
      `/terms/`, `/th/privacy/` and `/th/terms/`.
- [ ] An abuse contact address works.
- [ ] The Google app is published; the branding links work.
- [ ] `GET https://api.thothnotes.com/api/v1/capabilities` shows the trial limits.
- [ ] A test account hits the page limit and gets a clear message.
- [ ] Neon usage (compute-hours, storage) and Vercel usage are checked weekly
      for the first month.

## Moving domains (done once: `thoth.creaml4tt3.me` → `thothnotes.com`, ADR-0031)

1. Add the new domains in Vercel (or Pages) and DNS.
2. Update `PUBLIC_URL`, `CORS_ORIGINS`, `WEB_REDIRECT_URIS`, the Google
   redirect URI, the GitHub callback URL, the website's default server, and
   the desktop starter server (`packages/app-ui/src/workspace/starter.ts`).
3. Keep the old website domain redirecting (301) for a while.
4. Keep the old API domain **serving** (an alias of the same project), not
   redirecting, until desktop users have updated. The desktop app never follows
   a redirect (so a token cannot leak), and it remembers a server by its
   address, so an API redirect would cut existing installs off.

Web users sign in once more: cookies belong to the old domain. From 0.2.1 the
desktop app shows a demo server saved at `https://api.thoth.creaml4tt3.me` as
`https://api.thothnotes.com`, with the same sign-in
(`crates/thoth-host/src/remote/mod.rs`, `move_trial`). A server saved at any
other old address is the user's to add again.
