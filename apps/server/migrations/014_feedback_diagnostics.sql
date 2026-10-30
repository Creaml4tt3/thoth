-- The app log a person chose to attach to feedback (0.3.0, ADR-0033): `{"log": [...]}`, 1 to 200 printable lines of at
-- most 500 characters, already redacted on their computer; the protocol bounds it, this column only keeps it. NULL when
-- they did not attach one, and for every older row. Never read by the website form path.
--
-- Additive only (one new nullable column), so it is safe to apply to a live database while an older server build runs:
-- older builds never read or write it. Production runs with MIGRATE_ON_START=false: apply this migration
-- (`node src/cli.ts migrate`, direct URL) before deploying a server build that stores it.
ALTER TABLE feedback ADD COLUMN diagnostics jsonb NULL CHECK (diagnostics IS NULL OR jsonb_typeof(diagnostics) = 'object');
