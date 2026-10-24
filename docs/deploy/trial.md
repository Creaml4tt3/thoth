# Deploying the hosted trial (Vercel + Neon)

This is the checklist for the owner to set up the trial described in ADR-0014.
Every secret goes into the provider's dashboard or a password manager, never
into this repository, a chat or a terminal log.

Domains used below (change them when you buy your own domain):

| What | Address |
| --- | --- |
| Website (`apps/site`, with `apps/web` at `/app/`) | `https://thoth.creaml4tt3.me` |
| API (`apps/server`) | `https://api.thoth.creaml4tt3.me` |

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

Free-plan facts to keep in mind:
- 1 GB of storage.
- 100 compute-hours a month.
- The database sleeps after 5 minutes idle, so the first request after a quiet
  period takes a moment longer.

## 2. DNS for `creaml4tt3.me`

At your DNS provider, add a CNAME record for each host:

| Name | Type | Value |
| --- | --- | --- |
| `thoth` | CNAME | the target Vercel (or Cloudflare Pages) shows when you add the domain |
| `api.thoth` | CNAME | the target Vercel shows when you add the domain to the API project |

Keep the website and the API under the same parent domain. Two `*.vercel.app`
names do not work for sign-in cookies.

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
3. Add the domain `api.thoth.creaml4tt3.me`.
4. Environment variables (Production). Enter the values in the Vercel
   dashboard only:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon **pooled** URL |
   | `THOTH_PROFILE` | `trial` (sets the limits, the 300-account cap, rate limits and `EVENTS=off`) |
   | `MIGRATE_ON_START` | `false` |
   | `TRUST_PROXY` | `true` (Vercel sets the client IP header) |
   | `CORS_ORIGINS` | `https://thoth.creaml4tt3.me` |
   | `CRON_SECRET` | a long random value, e.g. from `openssl rand -base64 32`; Vercel Cron sends it automatically |
   | `PUBLIC_URL` | `https://api.thoth.creaml4tt3.me` (the sign-in redirect addresses are built from it) |
   | `SERVER_NAME` | `Thoth demo server` (the name the desktop app and web client show; the same as the starter server's name) |
   | `WEB_REDIRECT_URIS` | `https://thoth.creaml4tt3.me/app/callback` |

5. The daily cron job that calls `/internal/maintenance` is part of the build
   (`0 20 * * *` UTC, 03:00 in Thailand). The Hobby plan allows once a day.

## 4. Google sign-in (first provider)

1. In Google Cloud Console, create a project, then **Google Auth Platform →
   Branding**:
   - app name;
   - support email;
   - links to the published privacy notice and terms (`docs/legal/`);
   - authorized domain `creaml4tt3.me`.
2. **Audience**: External. Scopes: `openid`, `email`, `profile` only. These are
   non-sensitive, so no Google verification review is needed.
3. **Clients → Create client → Web application**, with:
   - Authorized redirect URI: `https://api.thoth.creaml4tt3.me/auth/callback/google`
   - No JavaScript origins needed: the browser never talks to Google directly.
4. Put the client ID and client secret into the API project's environment
   variables: `OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET`.
5. Publish the app (Testing mode only allows listed test users).

## 5. GitHub sign-in (second provider)

1. GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**, with:
   - Homepage URL: `https://thoth.creaml4tt3.me`
   - Authorization callback URL: `https://api.thoth.creaml4tt3.me/auth/callback/github`
2. Generate a client secret and put both values into the API project's
   environment variables: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
3. The server asks only for `read:user` and `user:email`.

## 6. Website project

The website at `thoth.creaml4tt3.me` is **one static deployment** made of two
builds (ADR-0015):

| Path | Built from | Output |
| --- | --- | --- |
| `/`, `/th/`, `/privacy/`, `/terms/`, `/th/privacy/`, `/th/terms/`, `sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`, `/analytics.js` | `apps/site` | `apps/site/dist` |
| `/app/` | `apps/web` (Vite `base: "/app/"`) | `apps/web/dist`, copied to `apps/site/dist/app` |
| `/media/` (showcase video, poster, captions) | rendered into `apps/site/public/media/` | copied by the site build |

`pnpm build:website` (`scripts/build-website.ts`) builds the site, builds
`apps/web` when it exists, and copies `apps/web/dist` into
`apps/site/dist/app`. Without `apps/web` it builds the site alone.

The project is connected to the repository with root directory `apps/site`
and deploys on every push to `main`. `apps/site/vercel.json` installs only the
site and the web client (`--filter @thoth/site... --filter @thoth/web...`) and
runs `pnpm build:website`. To deploy from your computer instead (from
`apps/site`): `vercel link --project thoth-site`, `vercel pull
--environment=production`, `vercel build --prod`, `vercel deploy --prebuilt
--prod`.

1. Create a second Vercel project from this repository with **root directory
   `apps/site`**. `apps/site/vercel.json` sets the install and build commands
   (both run from the repository root), the output directory `dist`, and:
   - security headers on every path (HSTS, `nosniff`, referrer and permissions
     policy);
   - the site's Content Security Policy as a header, including
     `frame-ancestors 'none'`, which browsers ignore in a meta tag. `/app/` is
     left out so the web client can send its own CSP (its `connect-src` needs
     the trial API);
   - `X-Robots-Tag: noindex` on `/app/` (`robots.txt` also disallows it);
   - a one-year immutable cache for hashed files in `/assets/` and
     `/app/assets/`, 30 days for `/media/`, 5 minutes for `/analytics.js`
     (its name is fixed, so the web client can include it);
   - a rewrite of `/app/*` to `/app/index.html` for the web client's routes.
2. Add the domain `thoth.creaml4tt3.me`.
3. Environment variables (Production), in the Vercel dashboard only:

   | Variable | Value |
   | --- | --- |
   | `SITE_URL` | `https://thoth.creaml4tt3.me` (the default; canonical URLs, `hreflang`, the sitemap and JSON-LD use it) |
   | `VITE_GA4_ID` | the GA4 measurement ID (`G-…`). Leave unset for no analytics code at all |
   | `VITE_DEFAULT_SERVER` | `https://api.thoth.creaml4tt3.me` (read by the web client's build) |

4. In Google Analytics (property settings):
   - **Data retention**: 2 months, to match the privacy notice;
   - **Google signals**: off; ads personalisation: off;
   - no user ID, no User-Provided Data collection.
5. Check after the first deploy:
   - `/`, `/th/`, `/privacy/` and `/app/` load;
   - before you choose in the cookie banner, the browser's network panel shows
     no request to Google;
   - `https://thoth.creaml4tt3.me/sitemap.xml` and `/robots.txt` load. Submit
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
- [ ] `GET https://api.thoth.creaml4tt3.me/api/v1/capabilities` shows the trial limits.
- [ ] A test account hits the page limit and gets a clear message.
- [ ] Neon usage (compute-hours, storage) and Vercel usage are checked weekly
      for the first month.

## Moving to a bought domain later

1. Add the new domains in Vercel (or Pages) and DNS.
2. Update `PUBLIC_URL`, `CORS_ORIGINS`, `WEB_REDIRECT_URIS`, the Google
   redirect URI, the GitHub callback URL, the website's default server, and
   the desktop starter server (`packages/app-ui/src/workspace/starter.ts`).
3. Keep the old website domain redirecting for a while.
4. Keep the old API domain **serving** (an alias of the same project), not
   redirecting, until desktop users have updated. The desktop app never follows
   a redirect (so a token cannot leak), and it remembers a server by its
   address, so an API redirect would cut existing installs off.

Signed-in users sign in once more: cookies belong to the old domain. Desktop
users add the new address and remove the old one.
