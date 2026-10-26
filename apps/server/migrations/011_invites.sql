-- Invite links (ADR-0024, capability `invite-links`). One row per link: the workspace, the role it gives, how many
-- people may still join with it, who made it, when it stops working, and the SHA-256 of its token. The token itself is
-- never stored (it is shown once, in the create response). Revoked, expired and used-up links stay as records.
--
-- Additive only (two new tables, their indexes, and one nullable column on auth_requests), so it is safe to apply to a
-- live database while an older server build runs: older builds never read the new tables, and they write
-- auth_requests without the new column (it stays NULL). Production runs with MIGRATE_ON_START=false: apply this
-- migration (`node src/cli.ts migrate`, direct URL) before deploying a server build that lists `members` and
-- `invite-links`.
CREATE TABLE IF NOT EXISTS invite_links (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  role         text NOT NULL CHECK (role IN ('editor', 'viewer')),
  max_uses     integer NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  -- Counted under the workspace row lock, together with the member quota.
  uses         integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  created_by   text NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);

-- Listing a workspace's links, newest first, and counting its active links for the quota.
CREATE INDEX IF NOT EXISTS invite_links_workspace_idx ON invite_links (workspace_id, created_at DESC, id DESC);

-- A browser that signed in from an invite page: the short-lived proof, kept in an HttpOnly cookie, that lets that
-- browser send the join form once. Only the SHA-256 of the cookie's value is stored. Removed by maintenance once expired.
CREATE TABLE IF NOT EXISTS invite_tickets (
  ticket_hash text PRIMARY KEY CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  invite_id   text NOT NULL REFERENCES invite_links (id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS invite_tickets_expires_idx ON invite_tickets (expires_at);

-- A sign-in started from an invite page goes through the broker's provider callback like any other; this names the
-- invite it returns to. NULL for every client sign-in (and for every row an older build writes).
ALTER TABLE auth_requests ADD COLUMN IF NOT EXISTS invite_id text REFERENCES invite_links (id) ON DELETE CASCADE;
