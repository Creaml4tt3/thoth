-- Public read-only share links (ADR-0023, capability `public-share`). One row per link: the shared page, who made it,
-- when it stops working, and the SHA-256 of its token. The token itself is never stored (it is shown once, in the
-- create response), so a database leak does not open any shared page.
--
-- Additive only (a new table and its indexes), so it is safe to apply to a live database; older server builds never
-- read the table. Production runs with MIGRATE_ON_START=false: apply this migration (`node src/cli.ts migrate`, direct
-- URL) before deploying a server build that lists `public-share`.
CREATE TABLE IF NOT EXISTS share_links (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  page_id      uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by   text NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- NULL = never expires.
  expires_at   timestamptz,
  revoked_at   timestamptz,
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id)
);

-- Listing a page's links, newest first, and counting a workspace's active links for the quota.
CREATE INDEX IF NOT EXISTS share_links_page_idx ON share_links (workspace_id, page_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS share_links_active_idx ON share_links (workspace_id) WHERE revoked_at IS NULL;
