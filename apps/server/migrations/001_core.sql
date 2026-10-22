-- Identity, workspaces, pages, immutable revisions and the change feed.

CREATE TABLE users (
  id           text PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Personal access tokens. Only the SHA-256 of a token is stored, never the token.
CREATE TABLE access_tokens (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id),
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz
);
CREATE INDEX access_tokens_user_idx ON access_tokens (user_id);

CREATE TABLE workspaces (
  id                text PRIMARY KEY,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  export_restricted boolean NOT NULL DEFAULT false,
  -- Head of the per-workspace change feed. Every write locks this row first (see README), so
  -- sequence numbers are gap-free and commit in order: a reader never skips an entry.
  change_seq        bigint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  user_id      text NOT NULL REFERENCES users (id),
  role         text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id, workspace_id);

-- The page row is the mutable pointer to the current revision (and a denormalized copy of its
-- title and parent for the tree). Content lives only in page_revisions.
CREATE TABLE pages (
  workspace_id        text NOT NULL REFERENCES workspaces (id),
  id                  uuid NOT NULL,
  parent_id           uuid,
  title               text NOT NULL,
  current_revision_id text NOT NULL,
  revision_count      integer NOT NULL CHECK (revision_count >= 1),
  created_at          timestamptz NOT NULL,
  created_by          text REFERENCES users (id),
  updated_at          timestamptz NOT NULL,
  updated_by          text REFERENCES users (id),
  deleted_at          timestamptz,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX pages_parent_idx ON pages (workspace_id, parent_id);

CREATE TABLE page_revisions (
  id                 text PRIMARY KEY,
  workspace_id       text NOT NULL,
  page_id            uuid NOT NULL,
  rev_no             integer NOT NULL CHECK (rev_no >= 1),
  parent_revision_id text REFERENCES page_revisions (id),
  created_at         timestamptz NOT NULL,
  author_id          text REFERENCES users (id),
  title              text NOT NULL,
  markdown           text NOT NULL,
  page_parent_id     uuid,
  size               integer NOT NULL CHECK (size >= 0),
  content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (workspace_id, page_id, rev_no),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id)
);

-- pages and revisions reference each other; the pointer is checked at commit.
ALTER TABLE pages
  ADD CONSTRAINT pages_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES page_revisions (id) DEFERRABLE INITIALLY DEFERRED;

-- Revisions are immutable (ADR-0005): refuse any UPDATE or DELETE, whoever issues it.
CREATE FUNCTION thoth_reject_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'page_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER page_revisions_immutable
  BEFORE UPDATE OR DELETE ON page_revisions
  FOR EACH ROW EXECUTE FUNCTION thoth_reject_revision_change();

-- Per-workspace ordered change feed. `seq` is the cursor position.
CREATE TABLE changes (
  workspace_id  text NOT NULL REFERENCES workspaces (id),
  seq           bigint NOT NULL CHECK (seq >= 1),
  kind          text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  actor_id      text REFERENCES users (id),
  page_id       uuid,
  revision_id   text,
  parent_id     uuid,
  title         text,
  attachment_id uuid,
  PRIMARY KEY (workspace_id, seq)
);
