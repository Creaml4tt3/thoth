-- Team memory (ADR-0052 rule 8, capability `team-memory`): the memories the members' agents share in a workspace.
--
-- - workspaces.memory_review: "Agents' memories need review", on by default; owners and managers change it.
-- - memory_proposals: an agent's memory, kept by the server so its author and the workspace's owners and managers can
--   see it, and, once applied, the record of who applied what (the agent, the author, the applier, when). Its text is
--   kept only while it waits; once settled, the page has it (applied) or nobody needs it (declined).
--
-- Additive only, so it is safe to apply to a live database while an older server build runs: older builds never read
-- the column or the table, and the column's constant default needs no rewrite of `workspaces`. Production runs with
-- MIGRATE_ON_START=false: apply this migration (`node src/cli.ts migrate`, direct URL) before deploying a server build
-- that lists `team-memory`. No backfill.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS memory_review boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS memory_proposals (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces (id),
  author_id           text REFERENCES users (id),
  agent               text NOT NULL,
  title               text NOT NULL,
  -- The page it changes (an update), or the page an applied new memory made; NULL for a new one that waits.
  page_id             uuid,
  base_revision_id    text,
  markdown            text,
  status              text NOT NULL CHECK (status IN ('pending', 'applied', 'declined')),
  created_at          timestamptz NOT NULL,
  settled_at          timestamptz,
  settled_by          text REFERENCES users (id),
  applied_revision_id text,
  CHECK ((status = 'pending') = (markdown IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS memory_proposals_workspace_idx ON memory_proposals (workspace_id, created_at DESC, id DESC);
