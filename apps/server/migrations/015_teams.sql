-- Teams and page visibility (ADR-0042, capability `teams`). A new role, `manager` (an editor who also manages teams and
-- visibility), teams of members inside a workspace, and pages (usually folders) limited to some teams. A limit applies
-- to the page and everything below it. Owners always see every page. Attachments are not limited (ADR-0042).
--
-- - page_visibility: one row per limited page. No row: everyone in the workspace sees it.
-- - page_visibility_teams: the teams that see a limited page. A limited page with no team left (its teams were deleted)
--   is seen by owners only: deleting a team never shows a page to more people.
-- - workspaces.visibility_seq: the change-feed position of the last change to who sees what. A change cursor from
--   before it is answered with 410 cursor_expired, so clients read the tree again.
--
-- Additive only (three new tables, one function, one column with a default, and two role checks widened to allow
-- 'manager'), so it is safe to apply to a live database while an older server build runs: older builds never read the
-- new tables and never write 'manager'. Production runs with MIGRATE_ON_START=false: apply this migration
-- (`node src/cli.ts migrate`, direct URL) before deploying a server build that lists `teams`; that build calls
-- thoth_hidden_pages on every page read.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'manager', 'editor', 'viewer'));
-- Only owners make invite links; a link may now make someone a manager.
ALTER TABLE invite_links DROP CONSTRAINT IF EXISTS invite_links_role_check;
ALTER TABLE invite_links ADD CONSTRAINT invite_links_role_check CHECK (role IN ('manager', 'editor', 'viewer'));

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS visibility_seq bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS teams (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id, team_id);

CREATE TABLE IF NOT EXISTS page_visibility (
  workspace_id text NOT NULL,
  page_id      uuid NOT NULL,
  PRIMARY KEY (workspace_id, page_id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_visibility_teams (
  workspace_id text NOT NULL,
  page_id      uuid NOT NULL,
  team_id      text NOT NULL,
  PRIMARY KEY (workspace_id, page_id, team_id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES page_visibility (workspace_id, page_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS page_visibility_teams_team_idx ON page_visibility_teams (team_id);

-- The pages of a workspace one account may not see: every limited page whose teams do not include the account, and
-- every page below one (deleted pages too, so the change feed and revisions of a deleted page stay hidden). Empty for
-- owners. UNION (not UNION ALL) ends the walk even if the data ever held a parent cycle.
CREATE OR REPLACE FUNCTION thoth_hidden_pages(ws text, uid text) RETURNS TABLE (id uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE hidden(id) AS (
    SELECT v.page_id FROM page_visibility v
     WHERE v.workspace_id = ws
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = ws AND m.user_id = uid AND m.role = 'owner')
       AND NOT EXISTS (SELECT 1 FROM page_visibility_teams t JOIN team_members tm ON tm.team_id = t.team_id AND tm.user_id = uid
                        WHERE t.workspace_id = ws AND t.page_id = v.page_id)
    UNION
    SELECT p.id FROM pages p JOIN hidden h ON p.parent_id = h.id WHERE p.workspace_id = ws
  )
  SELECT id FROM hidden
$$;
