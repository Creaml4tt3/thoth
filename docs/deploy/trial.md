# Deploying the hosted trial (Vercel + Neon)

This is the checklist for the owner to set up the trial described in ADR-0014.
Every secret goes into the provider's dashboard or a password manager, never
into this repository, a chat or a terminal log.

Domains used below (change them when you buy your own domain):

| What | Address |
| --- | --- |
| Website (`apps/web`) | `https://thoth.creaml4tt3.me` |
| API (`apps/server`) | `https://api.thoth.creaml4tt3.me` |

> Status: steps 1–5 can be done once the sign-in broker (Phase 2b part 2) is
> merged; its contract is `docs/protocol/sign-in.md`. Step 6 needs Phase 2c
> (the website).

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

1. Create a Vercel project from this repository, with root directory
   `apps/server`. The deploy configuration (`vercel.json`) is added with the
   sign-in work.
2. Choose the **function region** that matches the Neon region, for example
   `sin1` for Singapore.
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
   | `WEB_REDIRECT_URIS` | `https://thoth.creaml4tt3.me/app/callback` |

5. Add a daily cron job that calls `/internal/maintenance`. The Hobby plan allows
   once a day.

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

Static files from `apps/web`, either on Vercel (a second project) or on
Cloudflare Pages, with the domain `thoth.creaml4tt3.me`. The web client
connects only to this trial server (owner, 2026-10-24): its server address is
fixed at build time (planned variable: `VITE_DEFAULT_SERVER`,
`https://api.thoth.creaml4tt3.me`), and it has no "connect to another server"
field. Self-hosters use the desktop app, or host the web client themselves.

The desktop app suggests this server as its starter server (Settings →
Servers), with a short caution. The address is in
`apps/desktop/src/features/servers/starter.ts`.

## Before the trial goes public

- [ ] Every `[[OWNER: …]]` in `docs/legal/privacy.md` and `terms.md` is filled
      in, and both are published on the website.
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
   the desktop starter server (`apps/desktop/src/features/servers/starter.ts`).
3. Keep the old website domain redirecting for a while.
4. Keep the old API domain **serving** (an alias of the same project), not
   redirecting, until desktop users have updated. The desktop app never follows
   a redirect (so a token cannot leak), and it remembers a server by its
   address, so an API redirect would cut existing installs off.

Signed-in users sign in once more: cookies belong to the old domain. Desktop
users add the new address and remove the old one.
