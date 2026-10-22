# Thoth reference workspace server

Fastify 5 + PostgreSQL implementation of the [Thoth workspace protocol](../../docs/protocol/README.md)
(`protocol/openapi.yaml`). It is the reference implementation, not the only possible one. The behavioural
contract is the route registry in `packages/workspace-protocol` and the conformance suite in
`protocol/conformance`; the server passes the suite with nothing skipped.

Phase 2a scope: pages and immutable revisions, change feed, attachments, search, SSE hints, transfers,
personal-access-token authentication, an admin CLI, a container image. OIDC is phase 2b.

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
| `BLOB_DIR` | `./data/blobs` | Attachment bytes, content-addressed. |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Listen address. |
| `LOG_LEVEL` | `info` | pino level. |
| `MAX_MARKDOWN_BYTES` | 1 MiB | Advertised as `limits.maxMarkdownBytes`; larger is 413. |
| `MAX_ATTACHMENT_BYTES` | 25 MiB | Advertised as `limits.maxAttachmentBytes`; larger is 413. |
| `MAX_TRANSFER_BYTES` | 32 MiB | Body limit of `createTransfer`. |

The server speaks plain HTTP. Put a TLS-terminating reverse proxy in front of it; the protocol requires
HTTPS outside local development. Server-sent events need the proxy not to buffer responses.

## Admin CLI

```sh
node apps/server/src/cli.ts create-user --name "Ada"                    # prints the user ID
node apps/server/src/cli.ts create-workspace --name "Team" [--export-restricted]
node apps/server/src/cli.ts add-member --workspace <id> --user <id> --role owner|editor|viewer
node apps/server/src/cli.ts create-token --user <id> --out ./ada.token  # token goes ONLY to the file (0600)
node apps/server/src/cli.ts revoke-token --token-id <id>
```

`create-token` writes the token to `--out` with mode 0600, refuses to overwrite an existing file, and prints
only the token ID. A token is never printed, logged, or accepted as an argument; the database stores only its
SHA-256. Use it as `Authorization: Bearer $(cat ada.token)`.

## Containers (Podman)

```sh
export THOTH_DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"   # not stored in the repo
podman compose up --build -d      # postgres + server; server on http://127.0.0.1:8080
podman compose exec server node src/cli.ts create-user --name "Ada"
```

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
- **Revisions are immutable** in the schema: a trigger rejects `UPDATE` and `DELETE` on `page_revisions`.
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
- **Authentication** is the `Authenticator` interface (`src/auth.ts`); `PatAuthenticator` is the 2a implementation.
  OIDC (2b) adds another implementation and does not touch the routes.

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
7. **No rate limiting** (`429` is never produced) and no per-principal SSE connection cap.
8. **Blob garbage collection** is not implemented: an upload whose transaction rolls back leaves an unreferenced,
   content-addressed blob. Harmless, but it needs a sweeper before S3.
9. `GET /workspaces` lists up to 50 members per workspace in `members`; `memberCount` is exact.
