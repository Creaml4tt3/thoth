# Hosting your own Thoth server

**English** · [ภาษาไทย](self-host.th.md)

A Thoth server holds the shared workspaces. The desktop app works without one; you need a server only to work with
others. It is one container (Node.js 24) and a PostgreSQL 14 or newer database. Every setting is listed in
[`apps/server/README.md`](../../apps/server/README.md).

Docker and Podman both work. Every command below says `docker compose`; with Podman, type `podman compose`.

## Choose a setup

| You have | Use | Sign-in |
| --- | --- | --- |
| Nothing yet, or you want to try it | [`compose.yaml`](../../compose.yaml): the server and its own PostgreSQL | Access tokens from the admin CLI, or any provider below |
| Your own PostgreSQL (managed or not) and an OpenID Connect provider | [`compose.external.yaml`](../../compose.external.yaml): the server alone | Your provider (Keycloak, Authentik, Zitadel, Entra ID...), Google or GitHub |
| A Node.js host and no containers | `node apps/server/src/main.ts` from a checkout | Same as above |

## The image

`ghcr.io/creaml4tt3/thoth-server`, for `linux/amd64` and `linux/arm64`, published with every release:

| Tag | Follows |
| --- | --- |
| `0.2.7` | That release only. Best for production: you choose when to move. |
| `0.2` | The newest release of 0.2. |
| `latest` | The newest release. The default in the compose files. |

Set `THOTH_VERSION=0.2.7` (in your shell or in a `.env` file next to the compose file) to pin one. From a checkout,
`docker compose up --build -d` builds the image from the source instead.

## Option 1: the server and its database

No checkout needed:

```sh
mkdir thoth && cd thoth
curl -fsSLO https://raw.githubusercontent.com/Creaml4tt3/thoth/main/compose.yaml
printf 'THOTH_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env && chmod 600 .env   # keep this file: the database is created with it
docker compose up -d
curl http://127.0.0.1:8080/api/v1/capabilities      # the server answers
```

Then create a user, a workspace and an access token:

```sh
docker compose exec server node src/cli.ts create-user --name "Ada"                 # prints the user ID
docker compose exec server node src/cli.ts create-workspace --name "Team"           # prints the workspace ID
docker compose exec server node src/cli.ts add-member --workspace <workspace-id> --user <user-id> --role owner
docker compose exec server node src/cli.ts create-token --user <user-id> --out /data/ada.token
docker compose cp server:/data/ada.token ./ada.token                                # give it to Ada privately
```

In the desktop app: **Settings → Servers → Add server**, the server's address, and the token. To let people sign
in with an account instead, add the sign-in settings from Option 2 to the `server` service's `environment:`.

## Option 2: your PostgreSQL and your sign-in provider

```sh
mkdir thoth && cd thoth
curl -fsSLO https://raw.githubusercontent.com/Creaml4tt3/thoth/main/compose.external.yaml
curl -fsSL https://raw.githubusercontent.com/Creaml4tt3/thoth/main/server.env.example -o server.env
chmod 600 server.env      # it holds the database password and the client secret
# edit server.env: DATABASE_URL, PUBLIC_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
docker compose -f compose.external.yaml up -d
```

- **The database.** On its first start the server creates its tables and runs `CREATE EXTENSION pg_trgm` (search
  uses it). The user in `DATABASE_URL` needs that right, or an administrator runs the statement once. Add
  `?sslmode=require` for a managed database.
- **Your provider.** Create a confidential client (authorization code flow) and register the redirect URI
  `https://<PUBLIC_URL>/auth/callback/oidc`. Google and GitHub use `/auth/callback/google` and `/auth/callback/github`.
  The issuer must be `https`.
- **Accounts.** Anyone your provider lets sign in gets an account; a workspace owner then adds them to a workspace,
  or sends an invite link from the app.
- **A connection pooler** (PgBouncer, a `-pooler` host): set `MIGRATE_ON_START=false`, migrate once with a direct
  URL (`docker compose -f compose.external.yaml run --rm -e DATABASE_URL=<direct url> server node src/cli.ts migrate`),
  and keep `DATABASE_POOL_MAX` small.

Without containers: `pnpm install --prod --filter @thoth/server...` in a checkout, export the same variables, then
`node apps/server/src/main.ts`.

## HTTPS

The server speaks plain HTTP on `127.0.0.1:8080`. Put a reverse proxy in front of it, and set `TRUST_PROXY=true`
so the per-IP limits see the real client. Live updates use server-sent events; the server already sends
`X-Accel-Buffering: no` for nginx. With [Caddy](https://caddyserver.com), which gets the certificate itself:

```caddyfile
thoth.example.org {
	reverse_proxy 127.0.0.1:8080
}
```

With nginx, also set `proxy_buffering off;` and `proxy_read_timeout 1h;` for `/api/v1/workspaces/*/events` (or the whole site).

## Maintenance

Prunes old revisions (only with `REVISION_RETENTION_DAYS`), purges workspaces deleted more than 30 days ago, and
clears expired sign-in and rate-limit rows. Nothing runs it on its own; schedule it daily, for example with cron:

```sh
15 3 * * *  cd /srv/thoth && docker compose exec -T server node src/cli.ts maintenance
```

## Backups

Two things hold data: the database, and the `blobs` volume (attachments; not used with `BLOB_STORE=postgres`).

```sh
# Back up (Option 1; with your own database, use your provider's backups or pg_dump against it)
docker compose exec -T postgres pg_dump -U thoth -Fc thoth > thoth-$(date +%F).dump
docker compose exec -T server tar -C /data -cz blobs > blobs-$(date +%F).tar.gz

# Restore into a fresh install, before anyone uses it
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U thoth -d thoth --clean --if-exists < thoth-2026-10-29.dump
docker compose up -d server
docker compose exec -T server tar -C /data -xz < blobs-2026-10-29.tar.gz
```

Attachments are stored by content hash, so a blobs backup taken after the database backup is always complete.

## Upgrades

Read the [changelog](../../CHANGELOG.md), back up, then:

```sh
docker compose pull && docker compose up -d     # add -f compose.external.yaml for Option 2
```

The server applies new database migrations at start (all so far are additive). With `MIGRATE_ON_START=false`, run
`node src/cli.ts migrate` with the direct URL first. A pinned `THOTH_VERSION` moves only when you change it.

## A web client for your server

The web app on thothnotes.com talks only to the demo server. To serve one for yours, build it with your server's
address and serve `apps/web/dist` under `/app/` on your site:

```sh
VITE_DEFAULT_SERVER=https://thoth.example.org pnpm --filter @thoth/web build
```

Then set `WEB_REDIRECT_URIS=https://<your site>/app/callback` and `CORS_ORIGINS=https://<your site>` on the server.

## Security

- `server.env` and `.env` hold secrets: keep them `chmod 600` and out of git (the repository ignores `server.env`).
- The compose files publish the server on `127.0.0.1` only, and the bundled PostgreSQL not at all.
- The container runs as the unprivileged `node` user.
- Report a security problem to security@thothnotes.com ([`SECURITY.md`](../../SECURITY.md)), not in an issue.
