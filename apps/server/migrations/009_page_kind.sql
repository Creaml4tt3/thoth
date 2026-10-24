-- Page kind (ADR-0017, capability `page-kind`): the kind of a page ("page" or "folder"), derived by the server from the
-- frontmatter key `thoth_kind` of its Markdown on every write. Additive and nullable only, so it is safe to apply to a
-- live database: existing rows read as NULL (unknown, which clients treat as a page) and older server builds simply
-- ignore the columns.
--
-- Production runs with MIGRATE_ON_START=false: apply this migration (`node src/cli.ts migrate`, direct URL) before deploying
-- a server build that reads `kind`.
--
-- SQL cannot parse Markdown, so this migration cannot fill the column. After it, run `node src/cli.ts backfill-kind` once
-- (direct URL, safe to repeat and to run while the server is serving) so that folders written before this migration are
-- reported as folders. Until then they read as NULL, that is, as pages.
--
-- The kind lives on the page row only (it follows the current revision; a move never changes it) and, as `page_kind`, on
-- change entries. `changes` already has a `kind` column (the change kind, such as page.updated), hence the other name.
-- It never touches the immutable page_revisions rows (ADR-0005).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS page_kind text;
