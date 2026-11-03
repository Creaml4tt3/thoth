-- Presence (ADR-0041, capability `presence`): who has a workspace page open right now. A client sends a heartbeat for
-- the page it shows about every 15 seconds; a row whose `seen_at` is older than 45 seconds no longer counts and is
-- deleted by the next heartbeat on the page and by `maintenance`. What is kept: the workspace, the page, the account and
-- when it was last seen. Never page text, titles, the client's address or anything about the device.
--
-- Additive only (one new table), so it is safe to apply to a live database while an older server build runs: older
-- builds never read it. Production runs with MIGRATE_ON_START=false: apply this migration (`node src/cli.ts migrate`,
-- direct URL) before deploying a server build that lists `presence`.
CREATE TABLE IF NOT EXISTS page_presence (
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  page_id      uuid NOT NULL,
  -- A deleted account leaves no presence behind.
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, page_id, user_id)
);

-- `maintenance` deletes old rows by time.
CREATE INDEX IF NOT EXISTS page_presence_seen_idx ON page_presence (seen_at);
