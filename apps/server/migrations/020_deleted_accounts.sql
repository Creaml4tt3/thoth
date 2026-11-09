-- Inactive accounts (ADR-0014): when maintenance deletes an inactive account whose revisions or other history stay in
-- a workspace someone else owns, its row is kept as "Deleted account" (revisions are immutable). `deleted_at` marks
-- such a row so that MAX_ACCOUNTS counts only live accounts: kept rows would otherwise fill a trial server for good.
--
-- Additive only (one nullable column, no rewrite of `users`), so it is safe to apply to a live database while an older
-- server build runs: older builds never read it. Production runs with MIGRATE_ON_START=false: apply this migration
-- (`node src/cli.ts migrate`, direct URL) before deploying a server build that deletes inactive accounts. No backfill.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
