# Thoth reference workspace server

Fastify 5 + PostgreSQL implementation of the [Thoth workspace protocol](../../docs/protocol/README.md)
(`protocol/openapi.yaml`). It is the reference implementation, not the only possible one. The behavioural
contract is the route registry in `packages/workspace-protocol` and the conformance suite in
`protocol/conformance`; the server passes the suite with nothing skipped.

Phase 2a scope: pages and immutable revisions, change feed, attachments, search, SSE hints, transfers,
personal-access-token authentication, an admin CLI, a container image. Phase 2b adds the hosted trial mode
(quotas, a trial profile, Postgres blob storage, CORS, rate limiting, maintenance) and the sign-in broker
(Google / any OIDC issuer / GitHub, see Sign-in). Phase 3b adds page order (capability `page-order`: `position` and the
metadata-only `movePage`, migration `008_page_position.sql`) and the page kind (capability `page-kind`: `kind` on tree
nodes and page metadata, `pageKind` in the change feed, derived from the frontmatter key `thoth_kind` on every write,
migration `009_page_kind.sql`; run `node src/cli.ts backfill-kind` once after it for pages written earlier, ADR-0017).

## Run it

Needs Node 24 and a PostgreSQL 14 or newer (it uses `pg_trgm`, which ships in the standard contrib package).

```sh
export DATABASE_URL=postgres://user:password@localhost:5432/thoth
export BLOB_DIR=./data/blobs        # default
export HOST=127.0.0.1 PORT=8080     # defaults
node apps/server/src/cli.ts migrate # the server also migrates at startup
node apps/server/src/main.ts
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgres://...`. Never logged. |
| `DATABASE_POOL_MAX` | 10 | Connections this process may open (1 to 100). Keep it small on serverless hosts. |
| `MIGRATE_ON_START` | `true` | `false` skips migrations (and the migration lock) at startup. |
| `BLOB_STORE` | `fs` (`postgres` in the trial profile) | Where attachment bytes live: `fs` or `postgres`. |
| `BLOB_DIR` | `./data/blobs` | Attachment directory for `BLOB_STORE=fs`, content-addressed. |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Listen address. |
| `LOG_LEVEL` | `info` | pino level. |
| `EVENTS` | `on` (trial `off`) | `off`: no `ChangeHub`, no LISTEN connection, `events.sse` not advertised; the events route answers 501 `capability_not_supported`. |
| `THOTH_PROFILE` | `default` | `trial` fills the hosted-trial values below. Any explicit variable wins. |
| `MAX_MARKDOWN_BYTES` | 1 MiB (trial 256 KiB) | Advertised as `limits.maxMarkdownBytes`; larger is 413. |
| `MAX_ATTACHMENT_BYTES` | 25 MiB (trial 4 MiB) | Advertised as `limits.maxAttachmentBytes`; larger is 413. |
| `MAX_TRANSFER_BYTES` | 32 MiB (trial 4 MiB, never below the Markdown limit) | Body limit of `createTransfer`. |
| `MAX_WORKSPACES_PER_ACCOUNT` | none (trial 1) | Workspaces one account owns. Advertised. |
| `MAX_MEMBERS_PER_WORKSPACE` | none (trial 10) | Advertised. |
| `MAX_PAGES_PER_WORKSPACE` | none (trial 200) | Live pages; deleted pages do not count. Advertised. |
| `MAX_WORKSPACE_ATTACHMENT_BYTES` | none (trial 20 MiB) | Sum of a workspace's attachment sizes. Advertised. |
| `REVISION_RETENTION_DAYS` | none (trial 30) | Non-current revisions older than this are pruned by maintenance. Advertised. |
| `MAX_TOTAL_ATTACHMENT_BYTES` | none (trial 600 MiB) | Server-wide stored attachment bytes. Not advertised. |
| `MAX_ACCOUNTS` | none (trial 300) | Server-wide number of accounts. Not advertised. |
| `CORS_ORIGINS` | none | Comma-separated exact origins allowed from a browser (see CORS). |
| `RATE_LIMIT_PER_ACCOUNT`, `RATE_LIMIT_PER_IP` | off (trial 300 / 600 per 60 s) | Requests per window (see Rate limiting). |
| `RATE_LIMIT_WINDOW_SECONDS` | 60 | Fixed window length. |
| `TRUST_PROXY` | `false` | Trust `x-real-ip` / `x-forwarded-for` for the client IP. |
| `CRON_SECRET` | none | Enables `GET /internal/maintenance` (at least 16 characters). Never logged. |
| `SERVER_NAME` | host name of `PUBLIC_URL`, else `Thoth server` | Display name in `GET /capabilities` `server.name`, shown in the desktop app and web client. Trimmed; 1 to 64 characters, no control characters. |
| `PUBLIC_URL` | none | The server's public origin (`https://api.example.org`). Required when a sign-in provider is set; plain `http` only on a loopback host. |
| `OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET` | none | Google sign-in (issuer `https://accounts.google.com`). Secret never logged. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | none | Any other OIDC issuer (Keycloak, Authentik...), provider ID `oidc`. The issuer must be `https` unless it is a loopback host. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | GitHub OAuth App sign-in. |
| `GITHUB_URL`, `GITHUB_API_URL` | `https://github.com`, `https://api.github.com` | GitHub Enterprise or a test double. |
| `WEB_REDIRECT_URIS` | none | Comma-separated exact redirect URIs of the `thoth-web` client; without it that client does not exist. |
| `SIGNUP_LIMIT_PER_IP` | none (trial 10) | New accounts per client IP per 24 h. |
| `ACCESS_TOKEN_TTL_SECONDS` | 900 | Sign-in access token lifetime (60 to 3600). |
| `REFRESH_TOKEN_TTL_DAYS` | 30 | Refresh token lifetime, sliding (1 to 365). |
| `SESSION_MAX_DAYS` | 90 | Maximum age of a sign-in session; then the user signs in again (1 to 365). |
| `PUBLIC_SHARE` | `on` | Public read-only share links (ADR-0023, capability `public-share`). `off`: not advertised, the share calls answer 501, every `/s/<token>` address is the not-found page. |
| `MAX_SHARE_LINKS_PER_WORKSPACE` | none (trial 20) | Active (not revoked, not expired) share links per workspace; one more is 409 `quota_exceeded` (`shareLinksPerWorkspace`). |
| `SHARE_VIEWS_PER_LINK` | off (trial 300) | Requests to one share link (pages and pictures) per `RATE_LIMIT_WINDOW_SECONDS`, counted per token as given, known or not. |
| `SHARE_VIEWS_PER_IP` | off (trial 120) | Requests to any share link per client IP per window. |
| `INVITE_LINKS` | `on` | Invite links (ADR-0024, capability `invite-links`). `off`: not advertised, the invite calls answer 501, every `/i/<token>` address is the not-found page. Members management (`members`) stays on. |
| `MAX_INVITE_LINKS_PER_WORKSPACE` | none (trial 20) | Active (not revoked, not expired, not used up) invite links per workspace; one more is 409 `quota_exceeded` (`inviteLinksPerWorkspace`). |
| `INVITE_OPENS_PER_IP` | 60 | Invite pages (`/i/...`) opened per client IP per `RATE_LIMIT_WINDOW_SECONDS`; `unlimited` turns it off. |
| `INVITE_ACCEPTS_PER_IP` | 20 | Joins (`acceptInvite` and the join form) per client IP per window, counted before the token is looked up. |

Every limit is its own optional variable: unset means no limit. Each accepts a positive integer, or the word
`unlimited` to remove a value the trial profile would set. Invalid values stop the server at startup with a
message that names the variable and never echoes the value.

The server speaks plain HTTP. Put a TLS-terminating reverse proxy in front of it; the protocol requires
HTTPS outside local development. Server-sent events need the proxy not to buffer responses.

## Admin CLI

```sh
node apps/server/src/cli.ts create-user --name "Ada"                    # prints the user ID
node apps/server/src/cli.ts create-workspace --name "Team" [--export-restricted]
node apps/server/src/cli.ts add-member --workspace <id> --user <id> --role owner|editor|viewer
node apps/server/src/cli.ts create-token --user <id> --out ./ada.token  # token goes ONLY to the file (0600)
node apps/server/src/cli.ts revoke-token --token-id <id>
node apps/server/src/cli.ts backfill-kind [--batch <n>]  # once after migration 009: fills the page kind of older pages (ADR-0017)
node apps/server/src/cli.ts feedback list [--since 7d]    # feedback from users, newest first (ADR-0033)
node apps/server/src/cli.ts feedback export --json        # the same as JSON
```

`create-token` writes the token to `--out` with mode 0600, refuses to overwrite an existing file, and prints
only the token ID. A token is never printed, logged, or accepted as an argument; the database stores only its
SHA-256. Use it as `Authorization: Bearer $(cat ada.token)`.

## Hosted trial profile

`THOTH_PROFILE=trial` is a bundle of defaults for the hosted trial (Vercel Functions + Neon PostgreSQL free plan):

| Setting | Trial default | Why |
| --- | --- | --- |
| `MAX_WORKSPACES_PER_ACCOUNT` / `MAX_MEMBERS_PER_WORKSPACE` / `MAX_PAGES_PER_WORKSPACE` | 3 / 10 / 200 | owner decision (workspaces: 3 since ADR-0025, was 1) |
| `MAX_WORKSPACE_CREATIONS_PER_DAY` | 10 | ADR-0025: a guard against creating and purging over and over |
| `MAX_WORKSPACE_ATTACHMENT_BYTES` | 20 MiB | owner decision |
| `MAX_ATTACHMENT_BYTES` | **4 MiB** | Vercel Functions reject request bodies above 4.5 MB at the platform, before our code runs. Staying below it means a user sees our clear 413 `payload_too_large` instead of a platform error page. |
| `MAX_MARKDOWN_BYTES`, `MAX_TRANSFER_BYTES` | 256 KiB, 4 MiB | the same 4.5 MB ceiling applies to `createTransfer` |
| `REVISION_RETENTION_DAYS` | 30 | owner decision |
| `MAX_TOTAL_ATTACHMENT_BYTES` | 600 MiB | Neon's free plan has 1 GB of storage per project, shared by pages, revisions and (with `BLOB_STORE=postgres`) attachments |
| `BLOB_STORE` | `postgres` | a function's filesystem is ephemeral |
| `EVENTS` | `off` | no long-lived SSE on a 300 s function or a database that must be allowed to sleep (ADR-0014) |
| `MAX_ACCOUNTS` | 300 | keeps the database inside Neon's 1 GB; adjust after real usage |
| `RATE_LIMIT_PER_ACCOUNT` / `RATE_LIMIT_PER_IP` | 300 / 600 per 60 s | ample for a person whose client polls the change feed, small for a script |
| `SIGNUP_LIMIT_PER_IP` | 10 per 24 h | ADR-0014 rule 4: sign-up is limited per IP |
| `MAX_SHARE_LINKS_PER_WORKSPACE` / `SHARE_VIEWS_PER_LINK` / `SHARE_VIEWS_PER_IP` | 20 / 300 / 120 per 60 s | ADR-0023 rule 4: share links stay on in the trial, capped and rate limited |
| `MAX_INVITE_LINKS_PER_WORKSPACE` | 20 | ADR-0024: members and invite links are on in the trial, with the 10-member limit above |

Recommended companions (not part of the profile because they depend on the deployment):
`MIGRATE_ON_START=false`, `DATABASE_POOL_MAX=1` to `3`, `TRUST_PROXY=true`, `CORS_ORIGINS`, `CRON_SECRET`.
See `docs/deploy/trial.md` for the full setup.

### Quotas

A request that would exceed a quota is **409 `quota_exceeded`** (see `docs/protocol/README.md`, section 5, for why
not 403/413/429) with `quota`, `limit` and `current`, and writes nothing.

- **Pages.** Creating a page (`PUT` with `If-None-Match: *`) counts live pages; deleted pages and updates do not.
  A `to_workspace` transfer is checked against the room left at creation and again at commit, before any page is
  published: an over-limit transfer publishes nothing, and one refused at commit stays staged, so it can be retried
  after making room.
- **Attachment bytes per workspace.** The sum of `attachments.size` of the workspace, checked before any byte is stored.
  Every upload is one attachment row, so uploading the same bytes twice counts twice: the quota is "what this workspace
  holds", independent of how the server deduplicates storage.
- **Attachment bytes per server (`MAX_TOTAL_ATTACHMENT_BYTES`).** Counts each distinct content hash once, since
  identical bytes are stored once, so re-uploading known bytes never fills the server. When it would be exceeded the
  reply says the trial server is full and that nothing is wrong with the account or request; it carries no `limit` or
  `current` (they would tell every user how full the server is).
- **Workspaces per account, members per workspace, accounts.** Enforced in `admin.ts` (`createWorkspace --owner`,
  `addMember`, `createUser`), which call the shared checks in `quota.ts`, so the later sign-in and HTTP membership
  routes reuse them. Workspaces count the account's `owner` memberships. A role change is not a new member. The CLI
  reads the same environment as the server, so `THOTH_PROFILE=trial node src/cli.ts add-member ...` enforces the trial
  limits.
- All checks run under the per-workspace row lock (or, for server-wide and per-account counts, a transaction-scoped
  advisory lock), so concurrent requests cannot overshoot: at limit - 1 exactly one of N concurrent creates wins.
- A `quota_exceeded` reply is not stored under its `Idempotency-Key`: retrying after freeing room runs the request.

### Members and invite links (ADR-0024)

Every member reads the member list (`GET .../members`: names and roles, never emails); owners change roles and remove
members; anyone leaves. A workspace always keeps one owner (409 `last_owner`), checked under the workspace row lock.
Owners make invite links (`<PUBLIC_URL>/i/<token>`: editor or viewer, 1, 7 or 30 days, 1, 5 or 10 uses). On by
default; for a self-hosted server:

- **Off:** `INVITE_LINKS=off` hides invite links; members management stays.
- **Joining** without the web: `POST /api/v1/invites/accept` with the user's normal credential (the desktop app's
  Settings → Servers → "Join with an invite link"). With a sign-in provider configured, the invite page also offers
  "Sign in with … to join": that sign-in issues no code or token, only a 15-minute single-use join ticket (an HttpOnly
  cookie, stored as a SHA-256 in `invite_tickets`), and a `POST /i/accept` form joins. Without a provider the page
  explains the desktop path.
- **"Open in Thoth"** after joining points at the web client, derived from the first `WEB_REDIRECT_URIS` entry.
- **The CLI** `add-member` keeps working and refuses to demote a workspace's last owner.
- **Audit:** `member.role_changed`, `member.removed`, `member.left`, `member.joined`, `invite.created`,
  `invite.revoked`, each with the acting account.
- **Migration** `011_invites.sql` must be applied before a build that lists `members` and `invite-links` serves
  traffic (with `MIGRATE_ON_START=false`, `node src/cli.ts migrate` with the direct URL). It is additive.

### Several workspaces per account (ADR-0025)

Any signed-in account creates workspaces it owns (`POST /api/v1/workspaces`); owners rename (`PUT .../name`) and
delete them. On by default; `WORKSPACE_MANAGEMENT=off` switches it off.

- **Delete** sets `workspaces.deleted_at`: `workspaceAccess`, `listWorkspaces`, the share-link and invite-link lookups
  and the CLI's `add-member` leave the workspace out, so it is 404 everywhere at once; its active share and invite
  links are revoked in the same transaction, so a restore does not bring them back. Members are kept.
- **Restore** within 30 days (`POST /deleted-workspaces/{id}/restore`, owners). **Purge** at once
  (`DELETE /deleted-workspaces/{id}`, owners) or by `maintenance` after 30 days: pages, revisions, attachments,
  changes, transfers, links and memberships go; the audit trail stays. Blobs no other attachment names are removed
  after the purge commits, under the `blob-gc` advisory lock that uploads hold shared.
- **Quota.** `MAX_WORKSPACES_PER_ACCOUNT` counts owned workspaces including deleted ones that can still be restored.
  `MAX_WORKSPACE_CREATIONS_PER_DAY` caps API creations per account per UTC day (not sign-up, not the CLI).
- **Audit:** `workspace.created` (with the actor when made through the API), `workspace.renamed`, `workspace.deleted`,
  `workspace.restored`, `workspace.purged` (actor null when maintenance purged it).
- **Migration** `012_workspace_deletion.sql` must be applied before a build that lists `workspace-management` serves
  traffic. It is additive.

### Feedback (ADR-0033)

`POST /api/v1/feedback` takes a problem, an idea or a question from the apps and the website's support page, without
sign-in. On by default; `FEEDBACK=off` switches it off.

- **Stored** in `feedback` (migration `013_feedback.sql`, additive; apply it before a build that lists `feedback`): the
  kind, the message, the email given, the client details, the account of a valid credential, and an HMAC of the client
  address with the database's own salt. Never the address.
- **Limits:** 5 per 10 minutes and 30 per day per address and per account (429 with `Retry-After`). Behind a proxy, set
  `TRUST_PROXY=true`.
- **The website form** posts form-encoded from an origin in `CORS_ORIGINS` and gets an HTML page back.
- **Read it** with `cli.ts feedback list` or `feedback export --json`.

### Public share links (ADR-0023)

Owners and editors make a read-only link to a page (`createShareLink`), and anyone with the address reads the page
and its sub-pages at `<PUBLIC_URL>/s/<token>` without signing in. The pictures those pages use are served at
`/s/<token>/a/<id>`. On by default; for a self-hosted server:

- **Off:** `PUBLIC_SHARE=off`. The apps hide "Share…", and links made earlier stop working (they come back if it is
  switched on again, unless revoked or expired).
- **Limits:** `MAX_SHARE_LINKS_PER_WORKSPACE`, `SHARE_VIEWS_PER_LINK` and `SHARE_VIEWS_PER_IP` (above). Behind a
  proxy, set `TRUST_PROXY=true` so the per-IP limit sees the visitor's address.
- **Addresses** are built from `PUBLIC_URL`. Without it, from the address the request came to.
- **Migration** `010_share_links.sql` must be applied before a build that lists `public-share` serves traffic. With
  `MIGRATE_ON_START=false` (Neon, any separate migration step), run `node src/cli.ts migrate` with the direct URL
  first.
- **What is stored:** the link (page, creator, expiry, revocation) and the SHA-256 of its token. The token itself is
  shown once, in the create response, and never stored or logged. Request logs show `/s/[token]`.
- **Every request re-checks** that the link is not revoked or expired, the page is not deleted (a page moved out of
  the workspace is deleted there), the creator is still an owner or editor, the workspace is not export restricted,
  and the capability is on. Anything else, and any page or picture outside the subtree, is the same 404.
- **The page** is HTML the server renders from the Markdown, with no script and a strict CSP
  (`default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none';
  form-action 'none'`), `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and `nosniff`. Its
  stylesheet and the brand fonts are served from `/assets/share/` (`apps/server/assets/share`; the Vercel bundle
  embeds them). Raw HTML in a page is shown as text.

### Serverless notes (Vercel + Neon)

- **Migrations** run with a direct (non-pooled) URL via the CLI (`node src/cli.ts migrate`), not at function start:
  the migration runner uses a session-level `pg_advisory_lock`, which does not work through a PgBouncer
  transaction-mode pooler. `MIGRATE_ON_START=false` skips the runner and its lock entirely. The function itself
  uses the pooled URL.
- **Apply new migrations before deploying** a server build that needs them (for example `008_page_position.sql` before
  the build that reads `pages.position`, or `009_page_kind.sql` before the build that reads `pages.kind`, followed by
  `backfill-kind` once). Every migration so far is additive, so the running build keeps working.
- **No LISTEN/NOTIFY.** The pooled endpoint cannot carry it, and an always-open connection keeps a scale-to-zero
  database awake and burns compute hours. The trial profile sets `EVENTS=off`: no listener is started and `events.sse` is not
  advertised (clients poll the change feed).
- **Blobs** live in the `blobs` table (`BLOB_STORE=postgres`): content-addressed, `INSERT ... ON CONFLICT DO NOTHING`.
  The insert joins the request's transaction, so a failed request leaves no orphan. Bytes are read whole, so this
  store is for small attachments, not large files.
- **Pool size.** Each function instance has its own pool: keep `DATABASE_POOL_MAX` small.
- **Client IP.** Vercel sets `x-forwarded-for` (and `x-real-ip`) itself, overwriting what the client sent. Set
  `TRUST_PROXY=true` there. Without a trusted proxy in front, leave it unset: the headers are then ignored, so a client
  cannot pick its own rate-limit key.
- **Maintenance** runs from Vercel Cron: set `CRON_SECRET` and add a cron entry for `/internal/maintenance` (Vercel
  sends `GET` with `Authorization: Bearer $CRON_SECRET`).
- Statements time out after 30 s and requests are short; nothing relies on process memory between requests.

## Sign-in

The contract is [`docs/protocol/sign-in.md`](../../docs/protocol/sign-in.md); the code is `src/signin/`. With at least one
provider configured the server is an OAuth authorization server for its two public clients (`thoth-desktop`, loopback
redirect; `thoth-web`, `WEB_REDIRECT_URIS`) and a confidential OAuth client of each upstream provider. Without a provider
nothing changes: `/auth/*` is 404 and `/capabilities` has no `signIn` member.

```sh
export PUBLIC_URL=https://api.example.org
export OIDC_GOOGLE_CLIENT_ID=... OIDC_GOOGLE_CLIENT_SECRET=...   # from your secret store, never a committed file
# Register https://api.example.org/auth/callback/google (and /auth/callback/github) at the provider.
```

- **Routes.** `GET /auth/authorize` (chooser page when several providers and no `provider=`), `GET /auth/callback/:provider`,
  `POST /auth/token` (`authorization_code`, `refresh_token`), `POST /auth/revoke`. They need no bearer credential, count
  against `RATE_LIMIT_PER_IP`, and answer OAuth JSON (`Cache-Control: no-store`) or a small HTML page, never problem
  documents. CORS applies to token and revoke only.
- **Upstream.** OIDC uses discovery (its `issuer` must equal the configured one) and the JWKS, both cached for an hour; a
  token with an unknown `kid` causes one JWKS refetch (key rotation). ID tokens are verified with `node:crypto` (no JWT
  library): RS/PS/ES 256-512 only, never `none` or `HS*`; `iss`, `aud`/`azp`, `exp`/`iat` (60 s), `nonce`, `sub`. The
  email is kept only when `email_verified` is `true`. GitHub: `GET /user` (numeric `id` is the subject), `GET /user/emails`
  (primary and verified only). Upstream calls use `fetch` with a 10 s timeout, no redirects and a 1 MiB cap.
- **Accounts** are keyed by `(provider, subject)` in `identities`, never by email. A new account passes the per-IP sign-up
  limit (`sign_ups`, the IP stored only as a SHA-256) and `assertCanCreateAccount` in the same transaction; a refusal is
  `access_denied` to the client, and an existing account can always sign in.
- **Tokens.** Every state, binding value, code and token is 256 random bits, stored as its SHA-256. The upstream PKCE
  verifier and nonce are stored for the 10 minutes of the auth request and nulled when it is consumed. Session access
  tokens (`thoth_at_`) live in `access_tokens` with a `session_id`, so `PatAuthenticator` serves both kinds; it refuses a
  token whose session is revoked or past `SESSION_MAX_DAYS`. Refresh tokens (`thoth_rt_`) rotate; a reused one revokes
  the whole session (`auth.refresh_reuse` audit event), and a replayed code revokes the session it created.
- **Web client.** The refresh token is only in `__Secure-thoth_refresh` (`thoth_refresh` on plain http): `HttpOnly; Secure;
  SameSite=Strict; Path=/auth`. Refresh and cookie-based revoke also need an `Origin` from `CORS_ORIGINS`.
- **Logs** carry the provider, the client and a fixed reason, never a code, state, token, verifier, nonce or secret; the
  redaction list in `app.ts` also covers those names in case a handler ever logs them. Query strings are never logged.
- **Maintenance** also deletes expired auth requests and codes, refresh and session access tokens expired for a day,
  revoked or expired sessions, and sign-up counters older than a day (`signInRowsDeleted`).
- **Tests** (`test-db/signin.test.ts`) run the whole flow against an in-process OIDC issuer and a fake GitHub on
  127.0.0.1 (`test-db/fakes.ts`), following redirects by hand.

## CORS

`CORS_ORIGINS` lists exact origins (`https://app.example.org`, `http://localhost:5173`; no path, trailing slash or
wildcard; a bad entry stops startup). Only a listed origin gets `Access-Control-Allow-Origin` (echoed) with
`Access-Control-Allow-Credentials: true`, `Vary: Origin`, and `Access-Control-Expose-Headers: ETag, Location,
Retry-After, WWW-Authenticate`, on every reply including 401/404/405 and the event stream. A preflight (`OPTIONS` with
`Origin` and `Access-Control-Request-Method`) under `/api/v1` is answered 204 without authentication, with methods
`GET, POST, PUT, DELETE` and headers `Authorization, Content-Type, If-Match, If-None-Match, Idempotency-Key`. A request
from an unlisted origin is processed normally (authentication applies) but carries no CORS header, so the browser blocks
it. With `CORS_ORIGINS` unset nothing is added and a stray `OPTIONS` is an ordinary 405.

## Rate limiting

Off unless `RATE_LIMIT_PER_ACCOUNT` and/or `RATE_LIMIT_PER_IP` is set (the trial profile sets both). Counters are fixed windows
(`RATE_LIMIT_WINDOW_SECONDS`, default 60) in the `rate_limits` table, so the limit holds across instances. A check is
one statement (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`) on the database clock. The per-IP counter runs
first, for every `/api/v1` request including `/capabilities`; the per-account counter runs after authentication, so a
request with a bad token never spends an account's allowance. The 429 is `rate_limited` with `Retry-After` (seconds to
the end of the window). Preflights are not counted. Expired counters are removed by maintenance. The cost is one
extra database round trip per request, per enabled limit.

The client IP is the socket address unless `TRUST_PROXY` is set, then `x-real-ip`, else the last `x-forwarded-for` entry
(the one the trusted proxy appended).

## Maintenance

```sh
node apps/server/src/cli.ts maintenance      # prints {"workspacesPurged":..,"revisionsPruned":..,"idempotencyRecordsDeleted":..,"rateLimitRowsDeleted":..,"signInRowsDeleted":..,"feedbackDeleted":..}
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/internal/maintenance
```

- Prunes revisions older than `REVISION_RETENTION_DAYS` (only if set) that are **not** the current revision of any page
  (deleted pages keep their last revision) and are not pinned by a `from_workspace` transfer that is not terminal
  (`done`, `failed`, `aborted`). A surviving revision is never modified: if its parent was pruned its `parentId` keeps
  naming it and that revision now answers 404; `listPageRevisions` simply omits what is gone.
- Purges workspaces deleted more than 30 days ago (ADR-0025), one transaction each, then removes their unused blobs.
- Deletes idempotency records past the 24 h window and expired rate-limit rows.
- Revisions stay immutable. Migration 006 replaces the trigger so that `UPDATE` is always rejected and `DELETE` is
  allowed only inside a transaction that set `thoth.pruning = on` (transaction-local, so it cannot leak through a
  pooled connection). Only `pruneRevisions` sets it. The `parent_revision_id` foreign key is dropped for the same reason.
- `GET /internal/maintenance` is outside `/api/v1`, registered only when `CRON_SECRET` is set (otherwise 404 like any
  unknown route), requires `Authorization: Bearer <CRON_SECRET>` compared in constant time (401 otherwise), and is safe to
  run on any instance concurrently. The secret is redacted from logs. It is not rate limited.

## Containers (Podman)

```sh
export THOTH_DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"   # not stored in the repo
podman compose up --build -d      # postgres + server; server on http://127.0.0.1:8080
podman compose exec server node src/cli.ts create-user --name "Ada"
```

**Your own PostgreSQL and sign-in provider.** `compose.external.yaml` runs the server alone and reads its settings
from `server.env` (copy `server.env.example`; git-ignored, keep it `chmod 600`). The example covers `DATABASE_URL`,
`PUBLIC_URL`, `TRUST_PROXY`, `OIDC_*` and the pooler, blob and web-client options. Without compose:
`podman run --env-file server.env -e HOST=0.0.0.0 -p 127.0.0.1:8080:8080 -v thoth-blobs:/data/blobs localhost/thoth-server:dev`.

`podman compose` is a thin wrapper that runs an external provider; on this machine it found
`docker-compose` and works. If it reports that no compose provider is installed, either install one
(`brew install docker-compose` or `podman-compose`) or use plain Podman:

```sh
podman network create thoth
podman run -d --name thoth-db --network thoth -e POSTGRES_USER=thoth -e POSTGRES_DB=thoth \
  -e POSTGRES_PASSWORD -v thoth-pg:/var/lib/postgresql docker.io/library/postgres:18-alpine
podman build -f apps/server/Containerfile -t localhost/thoth-server:dev .
podman run -d --name thoth-server --network thoth -p 127.0.0.1:8080:8080 -v thoth-blobs:/data/blobs \
  -e DATABASE_URL="postgres://thoth:$THOTH_DB_PASSWORD@thoth-db:5432/thoth" localhost/thoth-server:dev
```

(`-e POSTGRES_PASSWORD` without a value forwards it from your environment, so it is not in `ps`.) The image is
multi-stage, runs as the unprivileged `node` user, contains production dependencies only, and keeps the pnpm
workspace layout because Node refuses to strip TypeScript types below `node_modules`. The data directories
live on named volumes.

## Tests

| Command | Needs | What |
| --- | --- | --- |
| `pnpm check` | nothing | typecheck, schema and OpenAPI drift, all unit tests (including `apps/server/test/`). No Podman. |
| `pnpm test:server` | Podman | `apps/server/test-db/`: one `postgres:18-alpine` container (random 127.0.0.1 port, data on tmpfs), one fresh database per test file, removed afterwards even on failure. Fails with one clear message if Podman or its machine is not running (`podman machine start`); never skips. |
| `pnpm server:conformance` | Podman | Builds the image, starts compose, provisions a user/workspace/token with the CLI (0600 temp file; the token reaches the suite via `THOTH_TOKEN`), runs `protocol/conformance/src/cli.ts`, tears everything down. |

## Design notes

- **One lock orders everything.** Every write first takes `SELECT ... FOR NO KEY UPDATE` on its workspace row.
  Writers in one workspace are therefore serialized, which gives gap-free change sequence numbers that commit in
  order (a reader holding cursor N never later sees an entry below N) and makes a stale `If-Match` impossible to
  race past (the page row is also locked `FOR UPDATE`). Reads take no locks. Writers in different workspaces do not
  block each other.
- **Revisions are immutable** in the schema: a trigger rejects every `UPDATE` on `page_revisions`, and every `DELETE`
  except the retention pruning of the maintenance job (see Maintenance).
- **Idempotency** records live in `idempotency_records`, scoped per principal, committed in the same transaction
  as the write, with a per-key advisory lock so a duplicate arriving mid-flight waits and replays rather than runs
  twice. Window: 24 h (also advertised).
- **SSE** hints travel through `LISTEN/NOTIFY` (`thoth_changes`). The `NOTIFY` is queued by a statement trigger on
  `changes`, so it is delivered only if the writing transaction commits. Each instance holds one dedicated
  listener connection and fans out to its own streams; after a listener reconnect every stream gets a hint.
  Streams re-check the token and membership every 30 s.
- **Authorization** is `workspaceAccess()`: not a member is 404, a member whose role lacks the permission is 403.
  Every route goes through it; transfers resolve the workspace first and return the same 404 text for a real
  transfer of another workspace and for an unknown ID.
- **Authentication** is the `Authenticator` interface (`src/auth.ts`); `PatAuthenticator` checks personal access tokens
  and sign-in access tokens alike (both are SHA-256 rows of `access_tokens`), so the sign-in broker did not touch the
  `/api/v1` routes.

## Deviations and open points

1. **Search is not PostgreSQL full-text search.** `to_tsvector` cannot segment Thai (no spaces between words), so
   the search is a case-insensitive substring match (`ILIKE '%q%'`) over title and Markdown of current revisions,
   accelerated by `pg_trgm` GIN indexes. Consequences: no stemming, no ranking beyond "title match first, then most
   recently updated", and a query shorter than three characters cannot use the trigram index (it scans the
   workspace). To revisit: a Thai-aware tokenizer (ICU word break, or `pg_bigm`/ParadeDB) for ranked search.
2. **Idempotent replay only answers requests that reach the handler.** A request rejected before the transaction
   (401, 404 for an unknown route, 405, 413 of the body-size limit, malformed JSON of the framework) is not stored.
3. **Change feed retention** is unbounded, so `cursor_expired` (410) is never returned. A cursor ahead of the head
   is 400 `cursor_invalid`.
4. **Deleted pages keep their ID.** `PUT If-None-Match: *` over a deleted page is 412 `revision_conflict`
   (protocol open question 5); `currentRevision` is the last revision. Revisions of deleted pages are kept but not
   readable through the API (404).
5. **A staged `to_workspace` page whose ID is taken before commit** fails the whole transfer (state `failed`,
   nothing published) and answers 409 `invalid_transfer_state`. The protocol leaves destination collisions open.
6. **Transfer attachments** (`attachmentIds`) are validated to exist in the workspace; they are not otherwise
   linked to the transfer.
7. **Rate limiting is opt-in** (see above) and there is no per-principal SSE connection cap.
8. **Blob garbage collection** is not implemented for the filesystem store: an upload whose transaction rolls back
   leaves an unreferenced, content-addressed blob. Harmless, but it needs a sweeper before S3. The Postgres store has
   no such orphans (its insert joins the request transaction). Neither store deletes the bytes of attachments that
   are no longer referenced, because attachments cannot be deleted through the API yet.
9. `GET /workspaces` lists up to 50 members per workspace in `members`; `memberCount` is exact.
10. **Sign-in, beyond sign-in.md.** A `sign_ups` table (IP hash, time) implements `SIGNUP_LIMIT_PER_IP`, and `sessions`
    records its `provider`. The binding cookie is named `__Host-thoth_signin` (`thoth_signin` on plain http). An unknown
    `client_id` at the token and revoke endpoints is 400 `invalid_client`. `thoth-web` sending a `refresh_token` in the
    body is refused (`invalid_request`) rather than ignored. Google ID tokens may carry `iss` `accounts.google.com`
    (without scheme), as Google documents; that alias is accepted for the Google issuer only.
11. **Sign-in open points.** Nothing deletes accounts inactive for 90 days yet (`users.last_seen_at` is maintained for
    it; ADR-0014 open question on email). An auth request row is written before the provider is visited, so without
    `RATE_LIMIT_PER_IP` a client can create many short-lived rows (maintenance removes them). Accounts cannot be linked
    across providers. There is no consent screen and no per-client scope: a token grants everything the account can do.
12. **Share links (ADR-0023).** Revoked and expired rows of `share_links` are kept (an audit trail of what was
    public); maintenance does not remove them yet. A link in a workspace that is (or later becomes) export restricted
    is refused (403 `export_restricted`) and stops working: a public link takes content out of the workspace, which
    ADR-0009's flag forbids. The owner has not decided this point; it is ADR-0023 open question 1. The shared subtree is
    found through `parent_id`, depth-limited to 64; an attachment is served only when a subtree page's current
    Markdown uses it (a mention in code does not count). `createShareLink` ignores `Idempotency-Key`, since a stored
    replay would keep the token.
