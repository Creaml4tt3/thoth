# Running Thoth locally

What works today (2026-10-22):

| Part | State |
| --- | --- |
| Desktop app with your Private Space (Markdown files on your computer), Blocks and Plain editors, search, Notion/Obsidian import | Works |
| Workspace server (PostgreSQL, pages, history, search, attachments, live updates) | Works; you talk to it with `curl` or the protocol test kit |
| The desktop app connecting to a server (sign in, browse a workspace, edit it) | **Not built yet.** It is the client half of Phase 2b/2c |

So today you can run both, but they do not talk to each other yet.

## 1. The desktop app

```sh
pnpm install
pnpm --filter @thoth/desktop tauri dev      # development window with live reload
pnpm --filter @thoth/desktop tauri build    # a real .app / .dmg in apps/desktop/src-tauri/target/release/bundle/
```

The first run asks for a folder to use as your Private Space. Any folder of
Markdown files works, including an Obsidian vault.

## 2. The server (Podman)

You need Podman running (`podman machine start`). From the repository root:

```sh
# A database password that exists only in this shell; it is never written to the repo.
export THOTH_DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
podman compose up --build -d    # builds this checkout; docs/deploy/self-host.md pulls the published image instead
curl http://127.0.0.1:8080/api/v1/capabilities     # proves the server is up
```

Create yourself, a workspace and a sign-in token. The commands print IDs, which
are not secret:

```sh
podman compose exec server node src/cli.ts create-user --name "Me"
#   -> usr_...   (copy it into the next commands)
podman compose exec server node src/cli.ts create-workspace --name "Team" --owner usr_...
podman compose exec server node src/cli.ts create-token --user usr_... --out /tmp/me.token
```

The token is written only to a file inside the server container, never to the
screen. Use it from inside the container:

```sh
podman compose exec server sh -c \
  'node -e "fetch(\"http://127.0.0.1:8080/api/v1/workspaces\",{headers:{authorization:\"Bearer \"+require(\"fs\").readFileSync(\"/tmp/me.token\",\"utf8\").trim()}}).then(r=>r.text()).then(console.log)"'
```

To use it from your Mac instead, copy the file out with
`podman compose cp server:/tmp/me.token ./me.token` and keep it out of git.

Stop and start:

```sh
podman compose stop            # keeps your data
podman compose up -d           # needs THOTH_DB_PASSWORD set to the SAME value as the first time
podman compose down -v         # deletes everything, including the database
```

Keep the password in a password manager if you want to keep the data: the
database was created with it.

Want the trial limits locally? Add `THOTH_PROFILE=trial` to the server's
`environment:` in `compose.yaml`. To give the server the name the apps show,
add `SERVER_NAME` there too (for example `SERVER_NAME: "Home notes"`); without
it the server is called "Thoth server". See `apps/server/README.md` for every
setting.

## 3. Connecting the app to the server (coming)

Planned flow once Phase 2b part 2 and the desktop client are built:

1. Desktop: **Settings → Workspaces → Add server**, enter `http://127.0.0.1:8080`.
2. Sign in. On a local server that uses personal tokens you paste a token. On
   the hosted trial you choose Google or GitHub.
3. The workspace appears in the sidebar under your Private Space. You can open
   and edit its pages, and move or copy pages between the two.
