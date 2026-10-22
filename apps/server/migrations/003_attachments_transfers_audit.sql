-- Attachment metadata. The bytes live in the blob store, addressed by `hash`.
CREATE TABLE attachments (
  workspace_id text NOT NULL REFERENCES workspaces (id),
  id           uuid NOT NULL,
  hash         text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  size         bigint NOT NULL CHECK (size >= 0),
  mime_type    text NOT NULL,
  file_name    text,
  created_at   timestamptz NOT NULL,
  created_by   text REFERENCES users (id),
  PRIMARY KEY (workspace_id, id)
);

-- Transfers (ADR-0006). A transfer is identified by the client's operationId (UUIDv7).
CREATE TABLE transfers (
  operation_id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  user_id      text NOT NULL REFERENCES users (id),
  direction    text NOT NULL CHECK (direction IN ('to_workspace', 'from_workspace')),
  mode         text NOT NULL CHECK (mode IN ('copy', 'move')),
  state        text NOT NULL CHECK (state IN ('stage', 'commit_destination', 'finalize_source', 'done', 'destination_committed_source_cleanup_pending', 'failed', 'aborted')),
  fingerprint  text NOT NULL,
  error_code   text,
  error_detail text,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE INDEX transfers_workspace_idx ON transfers (workspace_id);

-- Staged pages (to_workspace) and pinned source revisions (from_workspace). Staged content is
-- invisible to every page route until commit, and is cleared on abort.
CREATE TABLE transfer_items (
  operation_id uuid NOT NULL REFERENCES transfers (operation_id) ON DELETE CASCADE,
  position     integer NOT NULL,
  page_id      uuid NOT NULL,
  source_id    text,
  revision_id  text,
  state        text NOT NULL CHECK (state IN ('pending', 'staged', 'committed', 'skipped', 'failed')),
  error_code   text,
  parent_id    uuid,
  title        text,
  markdown     text,
  PRIMARY KEY (operation_id, position)
);

-- ADR-0009: audit events for membership, token, transfer and export actions. Never content or secrets.
CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     text,
  workspace_id text,
  action       text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id, id);
