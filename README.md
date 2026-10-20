# Thoth

Thoth is a local-first, open-source knowledge workspace. Notes are Markdown
files you own. Workspaces are optional, connected through an open protocol, and
AI agents run on CLI tools you already have.

> **Status:** pre-alpha. The Private Space core and the Notion/Obsidian import
> pipeline exist as tested TypeScript packages. There is no UI or desktop app
> yet. See [`docs/architecture/implementation-plan.md`](docs/architecture/implementation-plan.md).
>
> **License:** not yet decided (see [ADR-0011](docs/adr/0011-license-and-contribution-policy.md)).
> Do not redistribute.

## Layout

```text
packages/
  domain/             IDs, paths, hashing, core entity schemas
  content/            Markdown + frontmatter parsing, canonical PageDocument, link resolution/rewriting
  local-store/        Private Space vault: atomic CAS writes, journal, SQLite + FTS5 index
  importer-core/      Secure ZIP/folder sources, staged/resumable import pipeline, manifests
  importer-obsidian/  ObsidianVaultImporter, ObsidianZipImporter
  importer-notion/    NotionZipImporter, NotionMarkdownCsvImporter
protocol/schemas/     JSON Schema generated from the Zod schemas
docs/adr/             Architecture decision records
docs/architecture/    Content contract, import format research, plan
tests/                Fixtures and cross-package acceptance tests
```

## Development

Requires Node ≥ 24 (built-in `node:sqlite` with FTS5) and pnpm.

```sh
pnpm install
pnpm check          # typecheck + schema drift check + all tests
pnpm test           # tests only
pnpm schemas        # regenerate protocol/schemas from Zod
```

Packages ship TypeScript source and run directly on Node's type stripping. Use
erasable syntax only: no enums, namespaces or parameter properties.
