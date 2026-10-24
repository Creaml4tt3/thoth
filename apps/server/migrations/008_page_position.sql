-- Page order (ADR-0016 rule 4, capability `page-order`): an optional sibling sort key on pages and in the
-- change feed. Additive and nullable only, so it is safe to apply to a live database: existing rows read as
-- "no position" (sorted A-Z after positioned siblings) and older server builds simply ignore the columns.
--
-- Production runs with MIGRATE_ON_START=false: apply this migration (`node src/cli.ts migrate`, direct URL) before deploying
-- a server build that reads `position`.
--
-- The position lives on the page row only. A move is a metadata change and never touches the immutable
-- page_revisions rows (ADR-0005).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS position text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS position text;
