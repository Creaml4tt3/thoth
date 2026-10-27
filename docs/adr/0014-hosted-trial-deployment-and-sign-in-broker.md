# ADR-0014: Hosted trial deployment (Vercel + Neon) and the sign-in broker

- **Status:** Accepted (owner decisions 2026-10-22: Vercel or Cloudflare
  hosting, `thoth.creaml4tt3.me` until a domain is bought (bought 2026-10-27:
  `thothnotes.com`, ADR-0031), Neon or another free
  PostgreSQL, the trial limits below, Google then GitHub sign-in; region
  Singapore and contact `creaml4tt3@gmail.com` confirmed the same day). The
  account cap in rule 5 stays adjustable after real usage.
- **Date:** 2026-10-22
- **Deciders:** project owner
- **Refines:** ADR-0013 rules 1, 4 and 5.

## Context

ADR-0013 left hosting, the trial limits and the first sign-in providers open.
The owner decided:

1. Host on **Vercel or Cloudflare**. Start on the subdomain
   **`thoth.creaml4tt3.me`**, then move to a bought domain (done 2026-10-27:
   `thothnotes.com`, ADR-0031).
2. Trial limits: **1 workspace per account, up to 10 members, 200 pages and
   20 MB of files per workspace**. Revisions kept 30 days, and accounts inactive
   for 90 days deleted, as proposed in ADR-0013.
3. Database: **Neon's free plan**, or a free PostgreSQL from Vercel or Cloudflare.
4. Sign-in: **Google first, GitHub second.**

These platform facts were checked on 2026-10-22 against the providers'
documentation. Re-check them before launch, because free plans change.

- **Vercel Hobby** runs a Fastify app as one Vercel Function with no special
  setup.
  - A function runs for at most **300 s**. That limit includes time spent
    streaming, so an SSE stream is cut after 5 minutes.
  - Request and response bodies over **4.5 MB** are rejected by the platform
    before our code runs.
  - The function filesystem is temporary.
  - Hobby cron jobs run at most **once a day**.
  - Hobby is for **non-commercial, personal use**. A free trial of an
    open-source project fits; charging money would need the Pro plan.
- **Cloudflare**:
  - Workers cannot run the Fastify + `pg` server without a rewrite.
  - Containers need the $5/month Workers Paid plan.
  - R2 object storage has a free tier but needs a payment method on file.
  - Cloudflare Pages (static files) is free.
- **Neon Free**:
  - 1 GB of storage per project.
  - 100 CU-hours of compute per month: about 400 hours at the smallest size,
    which is less than a 720-hour month.
  - The database **always sleeps after 5 minutes idle**; this cannot be turned
    off on the free plan.
  - The pooled endpoint is PgBouncer in transaction mode, which does not support
    `LISTEN/NOTIFY` or session advisory locks.
  - A connection that stays open keeps the database awake and uses up the
    compute hours.
- **Vercel Blob** on Hobby allows 1 GB, but only about 10,000 simple operations
  a month.
- **Sign-in providers**:
  - **Google** "Web application" clients need the client secret when the
    authorization code is exchanged, even with PKCE.
  - **GitHub** always needs the client secret, does not offer CORS on its token
    endpoint, and is OAuth 2.0 rather than OIDC: it has no ID token.

  Neither provider can be used safely from a browser or desktop app alone,
  because the secret would have to ship inside the app.

## Decision

1. **Topology.** The site and the API share a registrable domain, so a
   `SameSite` cookie works between them.
   - **Website** (`apps/web`, static) at `https://thothnotes.com` (was
     `https://thoth.creaml4tt3.me` until ADR-0031), on
     Vercel or Cloudflare Pages; either works because the site is static files.
   - **API** (the reference server) at `https://api.thothnotes.com` (was
     `https://api.thoth.creaml4tt3.me`, still served), as a
     Vercel Function.
   - **Database:** a Neon free project in the region nearest the API function.

   Moving to a bought domain means changing two DNS records and the
   configuration (`CORS_ORIGINS`, the redirect URIs at Google and GitHub, and
   the website's default server URL). The trial must never be served from two
   unrelated `*.vercel.app` names: `vercel.app` is a public suffix, so cookies
   would be third-party and blocked.
2. **The server adapts by configuration, not by forking** (ADR-0013 rule 2).
   `THOTH_PROFILE=trial` sets:
   - **Live updates.** `events.sse` is off and not advertised. Clients poll the
     change feed, which is already the source of truth (protocol §9), while a
     window is visible. Long-lived SSE does not fit a 300 s function or a
     database that must be allowed to sleep. Self-hosted servers keep SSE.
   - **Attachments.** Stored in PostgreSQL (`BLOB_STORE=postgres`), with
     **4 MiB per file** (under Vercel's 4.5 MB body limit), 20 MiB per workspace
     and a server-wide cap of 600 MiB (`MAX_TOTAL_ATTACHMENT_BYTES`), all inside
     Neon's 1 GB. When the server-wide cap is reached, the error says the trial
     server is full, not that the user did something wrong.
   - **Database connections.** The API uses Neon's pooled URL. Migrations run
     from the admin CLI with the direct URL (`MIGRATE_ON_START=false` on Vercel).
   - **Rate limits** are counted in PostgreSQL, because serverless instances
     share no memory.
   - **Maintenance** (pruning old revisions, expired idempotency records and
     rate-limit rows) runs from a once-a-day Vercel Cron call. That call is
     authenticated with a secret kept in the Vercel project settings.
3. **Trial limits** (configuration defaults, advertised in `GET /capabilities`):

   | Limit | Value |
   | --- | --- |
   | Workspaces per account | 3 (was 1; ADR-0025 amendment below) |
   | Members per workspace | 10 |
   | Pages per workspace (deleted pages do not count) | 200 |
   | Attachments per workspace | 20 MiB |
   | Size of one attachment | 4 MiB |
   | Markdown per page | 256 KiB |
   | Earlier revisions kept | 30 days (the current revision is always kept) |
   | Inactive accounts | deleted after 90 days |

   A request over a limit gets the protocol error `quota_exceeded` and nothing is
   written.
4. **Sign-in broker.** This replaces ADR-0013 rule 1's "the server exchanges
   nothing on the client's behalf in v1".
   - **The server is the OAuth client.** The Thoth server is a confidential
     OAuth client of each upstream provider and keeps the provider secrets.
     Thoth clients never see a provider token or secret.
   - **Clients sign in to the Thoth server.** Desktop and web clients use the
     Authorization Code flow with PKCE (S256) against the Thoth server's own
     sign-in endpoints. Desktop uses a loopback redirect (RFC 8252); web uses
     `https://thothnotes.com/app/callback`.
   - **The server then sends the user on to the provider.** It runs its own
     Authorization Code + PKCE + `state` (and `nonce` for OIDC) with the
     provider and receives the result on its own redirect URI. The client's
     code is single-use, short-lived, and bound to the client's PKCE challenge
     and redirect URI.
   - **Upstream providers:**
     - **Google** through generic OIDC: discovery, JWKS signature check, `iss`,
       `aud`, `exp`, `nonce`, and `email_verified`. Any OIDC issuer can be
       configured the same way; self-hosters can use Keycloak, Authentik or
       similar.
     - **GitHub** through a small OAuth 2.0 adapter: the user ID comes from the
       GitHub API, and the email from the verified primary address.
   - **Identity.** An account is keyed by (provider, provider subject), never
     by email. The same email at two providers gives two accounts unless the
     user links them later.
   - **Tokens the server issues:**
     - **Access token:** opaque, 15 minutes, stored hashed like a personal
       access token. It is sent as `Authorization: Bearer`, so the resource
       routes do not change.
     - **Refresh token:** rotated on every use, single-use, revocable, with
       reuse detection. Where it is kept:
       - desktop: the OS keychain;
       - web: an `HttpOnly; Secure; SameSite=Strict` cookie scoped to the
         refresh path on the API origin;
       - never in `localStorage`, and the web access token is held in memory
         only.
   - **Creating accounts.** Sign-up only happens through a configured provider
     and is limited per IP and by the server-wide account cap (rule 5).
     Personal access tokens stay for scripts and self-hosting.
5. **Account cap and region.**
   - `MAX_ACCOUNTS` starts at **300**, so the database cannot fill Neon's 1 GB.
     Raise it after watching real usage.
   - The API function and Neon run in the **same region**: Singapore
     (Vercel `sin1`, Neon `aws-ap-southeast-1`), chosen by the owner.
6. **The privacy notice, terms and abuse contact are drafted** in `docs/legal/`.
   They must show the owner's contact address and be published on the website
   before the trial accepts sign-ups.

### Amendment (2026-10-26, ADR-0025): several workspaces per account

The owner asked for several workspaces per account on the trial ("3–5") and chose **3**. Deleted workspaces count
until they are purged (30 days, or "Delete permanently"), and an account may create at most 10 a day through the API
(`MAX_WORKSPACE_CREATIONS_PER_DAY`). See ADR-0025.

## Consequences

- Positive:
  - The whole trial runs on free plans with no payment method.
  - Moving to a bought domain is a configuration change.
  - GitHub works without a third-party OIDC bridge.
  - Provider secrets never leave the server.
  - Clients only ever speak to Thoth.
- Positive: the self-hosted server is unchanged unless the trial profile or the
  new variables are set.
- Negative:
  - The Thoth server now issues tokens. It is a small authorization server for
    its own clients, with its own sign-in endpoints and token storage. These
    need their own tests: replayed codes, PKCE mismatch, redirect URI mismatch,
    refresh reuse.
  - The trial has no push updates: open apps poll the change feed, so changes
    from others appear within the polling interval rather than at once.
  - Neon's 100 CU-hours do not cover a database that is awake all month. If the
    trial is busy every hour of the day it stops until the next month, unless
    it moves to Neon's pay-as-you-go Launch plan. Usage must be watched.
  - Storing attachments in PostgreSQL limits the whole trial to well under 1 GB
    of files. Moving to object storage (R2 or S3) is a later change behind the
    existing `BlobStore` interface.
- Follow-up:
  - Phase 2b part 1, trial mode: limits, `quota_exceeded`, CORS, rate limits,
    maintenance, the PostgreSQL blob store, the EVENTS switch.
  - Part 2: the sign-in broker with a local test OIDC issuer and a fake GitHub.
  - Part 3: desktop loopback sign-in and keychain storage.
  - Phase 2c: the website's sign-in and change-feed polling.
  - Deployment files: `vercel.json` and a deployment guide.

## Alternatives considered

- **Clients talk to Google or GitHub directly with PKCE and no secret.** This
  does not work: both providers require the secret for these client types, and
  GitHub's token endpoint has no CORS.
- **An external identity service (Auth0, Clerk, Neon Auth, Better Auth).**
  It adds a vendor and a second user database. A small broker inside the
  reference server keeps self-hosting to a single process.
- **Cloudflare Workers or Containers for the API.** Workers would mean a rewrite
  away from Fastify and `pg`; Containers are not free.
- **Vercel Blob or R2 for attachments.** Vercel Blob's free operation count is
  too low; R2 needs a payment method. Both remain options behind `BlobStore`.
- **Keep SSE on the trial using a direct Neon connection.** One listener would
  keep the database awake around the clock and use up the free compute in
  about 17 days.

## Spec references

Section 2 (open protocol, reference server), 8 (server API), 11 (deployment,
rate limits), 12 (browser sessions, secrets, abuse), 13 (P2 web client).

## Open questions

- ~~The owner's contact address.~~ `creaml4tt3@gmail.com`, filled into
  `docs/legal/`. The remaining `[[OWNER: …]]` items there (publication date,
  log retention, applicable law, minimum age) are filled in at publication.
- Emailing a notice before an inactive account is deleted needs an email
  sending service. Until one is chosen, the warning is shown in the app at
  sign-in instead. Blocks deleting inactive accounts, not the launch.
- ~~The product name.~~ The owner keeps **Thoth** (2026-10-22). The clash
  with the unrelated voice app at thoth-app.com remains a known risk; buying a
  domain is still open, and moving to it is a configuration change (rule 1).
