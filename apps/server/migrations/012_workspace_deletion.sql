-- Several workspaces per account (ADR-0025, capability `workspace-management`): an owner deletes a workspace, it is
-- kept 30 days for its owners to restore, and then the daily maintenance purges it with its pages, revisions and
-- attachments. A deleted workspace is a workspaces row with `deleted_at` set: every route answers 404 for it, it is not
-- listed, its share and invite links stop. Its memberships stay, so a restore brings the members back.
--
-- Additive only (two nullable columns and a partial index), so it is safe to apply to a live database while an older
-- server build runs: older builds never set or read the columns, and every existing row reads as "not deleted".
-- Production runs with MIGRATE_ON_START=false: apply this migration (`node src/cli.ts migrate`, direct URL) before
-- deploying a server build that lists `workspace-management`.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- The owner who deleted it (shown in "Recently deleted"). NULL for live workspaces.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_by text REFERENCES users (id);

-- "Recently deleted" and the maintenance purge look only at deleted rows.
CREATE INDEX IF NOT EXISTS workspaces_deleted_idx ON workspaces (deleted_at) WHERE deleted_at IS NOT NULL;
