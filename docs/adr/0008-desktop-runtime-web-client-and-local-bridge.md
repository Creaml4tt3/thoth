# ADR-0008: Desktop runtime, web client, and local bridge

- **Status:** Accepted for: Tauri 2 + Rust desktop; React + TypeScript + Vite UI
  shared by desktop and web; desktop hosting of the ports via Rust commands
  (owner decision, 2026-10-21). Proposed for the local bridge.
- **Date:** 2026-10-20 (hosting decision added 2026-10-21)

## Context

Locked decisions: React + TypeScript + Vite frontend, Tauri 2 + Rust desktop,
desktop and web clients (spec section 2). Domain, content, transfer, protocol
schemas and agent-core must be independent of React, Tauri and Fastify
(section 4). Browsers cannot access local files or spawn processes, so access
from web to Private Space or local CLIs needs an explicit local bridge
(sections 3.3, 12).

## Decision

1. **Accepted:** Tauri 2 + Rust for the desktop shell; React + TypeScript + Vite
   for the UI shared by desktop and web.
2. **Ports.** Domain logic (`domain`, `content`, `local-store`, importers,
   `transfer`) is TypeScript, framework-independent, and reaches the platform
   only through two ports: `VaultFs` (scoped filesystem) and `SqlDriver`
   (SQLite).
3. **Node implementation for tests and CLI.** `node:fs` and built-in `node:sqlite`
   with FTS5 (Node >= 24) implement the ports today.
4. **Web client** performs connected workspace operations only. It reaches Private
   Space or local CLIs only through a separately installed local bridge with
   strong authentication, origin checks and narrowly scoped permissions. The
   bridge is implemented only after its security model is reviewed (spec section
   15 step 8).
5. **Desktop hosting of the ports (Accepted 2026-10-21, option (a)).** The
   TypeScript domain packages run in the Tauri webview. Rust Tauri commands
   implement `VaultFs` and `SqlDriver`; there is no bundled Node runtime.
   - **Security boundary.** The webview is untrusted. The Rust `VaultFs`
     commands are scoped to the vault root opened by the user and give the
     same guarantees as `NodeVaultFs`: vault-relative paths only, no symlink
     following (`O_NOFOLLOW` plus ancestor checks), exclusive create, and
     no-replace rename with the exclusive-copy fallback.
   - **SQLite.** `rusqlite` with the `bundled` feature, which includes FTS5,
     on SQLite >= 3.34 for the `trigram` tokenizer. The connection is owned by
     Rust and keyed to the open vault.
   - **Watcher.** The Rust `notify` crate. It emits debounced change events
     that trigger `vault.reconcile()` in the webview, as a trigger only, per
     ADR-0001.
   - **Port contract.** One shared port test suite runs against
     `NodeVaultFs`/`NodeSqlDriver` in Vitest and against the Rust commands in
     the desktop e2e suite.
   - **Windows file layer (2026-10-25).** Windows has no `openat`; the host
     uses `NtCreateFile` with `RootDirectory` set to the vault's directory
     handle, one component per open, always with `FILE_OPEN_REPARSE_POINT`
     and the handle's reparse attribute checked (`crates/thoth-host/src/win`).
     The guarantees above hold. Where they differ from macOS and Linux:
     - *Stronger.* The root's final path must equal its canonical path, which
       refuses a junction swapped into an ancestor after canonicalization
       (macOS gets this from `O_NOFOLLOW_ANY`; Linux checks only the final
       component). No-replace rename is the volume's own atomic rename without
       replace, so no moment has both names (POSIX uses `link()` then
       `unlink()`). Every reparse point is refused, not only symlinks
       (junctions, mount points, and data reparse points such as deduplicated
       files, reported as `other`). Names Windows cannot hold (`CON`,
       `a.md:stream`, a trailing dot or space, `<>:"|?*`) can never be
       created, and are "not found" on lookup. Lookups are
       normalization-insensitive, like APFS: an NFD name is found by its NFC
       spelling, and creating its NFC twin is `EEXIST`. Import temp files are
       `FILE_FLAG_DELETE_ON_CLOSE`, so they go even if the host crashes.
     - *Weaker or different.* (1) SQLite enforces `SQLITE_OPEN_NOFOLLOW` only
       in its Unix VFS, so on Windows the host checks `.thoth/index.sqlite`
       and its `-wal`, `-shm` and `-journal` files through the root handle
       just before SQLite opens them by path: a file symlink swapped in
       within that window would be followed. Creating a file symlink needs
       Developer Mode or an elevated account, and `.thoth` itself is checked
       through the handle. (2) A rename is not followed by a directory flush:
       Windows cannot flush a directory handle; NTFS journals the rename
       (POSIX's directory `fsync` is best effort too). File data is flushed
       with `FlushFileBuffers` as before. (3) Another program holding a file
       open without `FILE_SHARE_DELETE` blocks renaming, replacing or deleting
       it (`EPERM`/`EIO`); the CAS write then fails and nothing is lost. (4)
       There are no mode bits: import temp folders and agent working folders
       are private through the ACLs they inherit from `%TEMP%` and
       `%APPDATA%`, not `0700`/`0600`, and the host does not verify them. (5)
       On volumes without POSIX rename and delete semantics (FAT, exFAT, some
       network shares) the classic semantics are used: replacing a target
       another program has open, or a read-only one, fails there. (6) Case
       follows the volume: case-insensitive by default, case-sensitive in a
       folder with per-directory case sensitivity, as on Linux.
     - *Agent Hub (ADR-0007 rule 7).* The CLI runs in a kill-on-close Job
       Object instead of a process group. There is no SIGTERM first: cancel
       and timeout end the whole tree at once, and a host crash kills it too.

## Consequences

- Positive: the same TypeScript domain code runs in tests, CLI and the app; the
  runtime is swappable behind two narrow ports.
- Positive: web never gains local access by default.
- Negative: every port call crosses Tauri IPC, which is asynchronous (the ports
  already are). Hot paths such as reconcile and indexing transactions may need
  a batched SQL command later. Measure before optimizing.
- Negative: Rust must re-implement the filesystem safety rules that
  `NodeVaultFs` enforces today; the shared port test suite is the guard.
- Negative: SQLite FTS5 availability must be guaranteed on every runtime that
  implements `SqlDriver`.
- Follow-up: define `VaultFs` and `SqlDriver` contracts and a shared port test
  suite that every implementation must pass.

## Alternatives considered

- **Electron.** Not chosen: Tauri 2 + Rust is a locked decision.
- **Browser File System Access API as the web-to-local path.** Not decided; the
  spec requires an explicit bridge for local access.
- **Domain logic in Rust.** Not chosen: spec section 4 keeps domain packages in
  TypeScript, shared with the server and web.

## Spec references

Section 2, 3.3, 4 (runtime boundary), 5, 12, 15 steps 2 and 8.

## Open questions

- ~~How the Tauri app hosts the ports.~~ Decided 2026-10-21: option (a), Rust
  commands. Option (b), a bundled Node sidecar, was rejected because it ships a
  second runtime and a larger attack surface.
- Local bridge security model (authentication, origin checks, permission scopes,
  transport). To be reviewed before implementation.
- Watcher debounce interval and behaviour on network or cloud-synced folders.
