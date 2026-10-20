# ADR-0008: Desktop runtime, web client, and local bridge

- **Status:** Accepted for: Tauri 2 + Rust desktop; React + TypeScript + Vite UI
  shared by desktop and web. Proposed for the rest.
- **Date:** 2026-10-20

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
5. **Desktop hosting of the ports (undecided; see Open questions).**

## Consequences

- Positive: the same TypeScript domain code runs in tests, CLI and the app; the
  runtime is swappable behind two narrow ports.
- Positive: web never gains local access by default.
- Negative: the desktop shell cannot be completed until the hosting question is
  resolved; this blocks the shell, not the packages.
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

- **Blocks the desktop shell, not the packages:** how the Tauri app hosts the
  ports.
  - (a) Rust Tauri commands implement `VaultFs` and `SqlDriver` scoped to the vault
    root, with the TypeScript logic running in the webview.
  - (b) A bundled Node sidecar runs the TypeScript packages.
  - Lead recommendation: (a), because it avoids shipping a second runtime. It
    requires a Rust rusqlite build with FTS5 enabled and strict path scoping in
    commands. This is a recommendation, not a decision.
- Local bridge security model (authentication, origin checks, permission scopes,
  transport). To be reviewed before implementation.
- Filesystem watcher implementation per runtime.
