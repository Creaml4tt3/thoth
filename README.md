# Thoth

Thoth is a local-first, open-source knowledge workspace. Notes are Markdown
files you own. Workspaces are optional, connected through an open protocol, and
AI agents run on CLI tools you already have.

> **Status:** pre-alpha. The Private Space desktop app (Tauri) with its editor
> and the Notion/Obsidian import wizard runs locally; the workspace server and
> Agent Hub are not built yet. See [`docs/architecture/implementation-plan.md`](docs/architecture/implementation-plan.md).
>
> **License:** [Apache-2.0](LICENSE) (see [ADR-0011](docs/adr/0011-license-and-contribution-policy.md)).

## Layout

```text
apps/
  desktop/            React UI (Vite) and src-tauri/, the Tauri 2 shell
  site/               Landing site: static HTML in English and Thai (pnpm build:website)
crates/
  thoth-host/         Rust host: scoped VaultFs/SqlDriver/SourceHost, watcher, stdio test harness
packages/
  domain/             IDs, paths, hashing, core entity schemas
  content/            Markdown + frontmatter parsing, canonical PageDocument, link resolution/rewriting
  editor/             Tiptap schema and byte-preserving Markdown serializer
  local-store/        Private Space vault: atomic CAS writes, journal, SQLite + FTS5 index
  importer-core/      Portable ZIP reader, secure sources, staged/resumable import pipeline
  importer-obsidian/  ObsidianVaultImporter, ObsidianZipImporter
  importer-notion/    NotionZipImporter, NotionMarkdownCsvImporter
  platform/           Platform/IPC contract; Tauri, stdio and test HTTP transports
  workspace-protocol/ Workspace protocol Zod schemas and route registry
  ui/                 Design tokens (Ink & Moon)
protocol/             openapi.yaml, JSON schemas, conformance suite
docs/adr/             Architecture decision records
docs/architecture/    Content contract, import format research, plan
tests/                Fixtures and cross-package acceptance tests
```

## Development

Requires Node ≥ 24 (built-in `node:sqlite` with FTS5), pnpm, and Rust ≥ 1.90
(the port contract tests build `crates/thoth-host`).

```sh
pnpm install
pnpm check          # typecheck + schema/OpenAPI drift checks + all tests
pnpm test           # tests only
pnpm e2e            # Playwright: real UI on the real Rust host (needs Chromium: npx playwright install chromium-headless-shell)
pnpm schemas        # regenerate protocol/schemas from Zod
pnpm --filter @thoth/desktop tauri dev     # run the desktop app
```

Packages ship TypeScript source and run directly on Node's type stripping. Use
erasable syntax only: no enums, namespaces or parameter properties.
