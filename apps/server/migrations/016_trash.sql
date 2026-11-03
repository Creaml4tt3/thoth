-- The Trash for pages, and managers who see every page (ADR-0043, capability `trash`).
--
-- - A deleted page (pages.deleted_at set, as before) is in its workspace's Trash for 30 days: owners and managers
--   restore it or delete it for good; an editor restores what they deleted. pages.updated_by names who deleted it
--   (deletePage sets it, and a deleted page is never written again until it is restored). After 30 days the daily
--   maintenance removes it with its revisions.
-- - thoth_hidden_pages: managers, like owners, see every page.
--
-- Pages deleted before this migration were kept with no way back; they get the full 30 days from now, so the first
-- maintenance run after the upgrade does not remove them at once. Otherwise additive (one partial index, and the
-- function widened), safe to apply while an older server build runs: an older build reads deleted_at only as "is
-- deleted", and shows managers less, never more. Production runs with MIGRATE_ON_START=false: apply this migration
-- (`node src/cli.ts migrate`, direct URL) before deploying a server build that lists `trash`.
UPDATE pages SET deleted_at = now() WHERE deleted_at IS NOT NULL AND deleted_at < now();

-- The Trash and the purge read only deleted pages.
CREATE INDEX IF NOT EXISTS pages_deleted_idx ON pages (workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION thoth_hidden_pages(ws text, uid text) RETURNS TABLE (id uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE hidden(id) AS (
    SELECT v.page_id FROM page_visibility v
     WHERE v.workspace_id = ws
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = ws AND m.user_id = uid AND m.role IN ('owner', 'manager'))
       AND NOT EXISTS (SELECT 1 FROM page_visibility_teams t JOIN team_members tm ON tm.team_id = t.team_id AND tm.user_id = uid
                        WHERE t.workspace_id = ws AND t.page_id = v.page_id)
    UNION
    SELECT p.id FROM pages p JOIN hidden h ON p.parent_id = h.id WHERE p.workspace_id = ws
  )
  SELECT id FROM hidden
$$;
