-- Trial mode (phase 2b): Postgres blob storage, rate-limit counters, and revision pruning.

-- Attachment bytes for hosts without a persistent filesystem (BLOB_STORE=postgres). Content-addressed,
-- exactly like the filesystem store: the hash is the key, identical content is stored once.
CREATE TABLE blobs (
  hash       text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  size       bigint NOT NULL CHECK (size >= 0),
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(data) = size)
);

-- Server-wide storage accounting and deduplication look attachments up by content hash.
CREATE INDEX attachments_hash_idx ON attachments (hash);

-- Fixed-window request counters shared by every server instance. One row per (key, window).
-- `key` is `acct:<user id>` or `ip:<address>`; rows are removed by maintenance once expired.
CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start bigint NOT NULL,
  count        integer NOT NULL,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_expires_idx ON rate_limits (expires_at);

-- Revisions stay immutable (ADR-0005) with ONE exception: the maintenance job may DELETE old,
-- non-current revisions under the retention policy. It does so inside a transaction that sets
-- `thoth.pruning = on` (transaction-local), which this trigger checks. UPDATE is rejected always, so the
-- content of a revision can never change, not even while pruning.
CREATE OR REPLACE FUNCTION thoth_reject_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('thoth.pruning', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'page_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;

-- A revision's `parent_revision_id` keeps naming the previous revision even after that one was pruned,
-- so a retained revision's summary never changes. The reference may therefore dangle; the protocol
-- says a pruned revision is 404, and clients already handle that.
ALTER TABLE page_revisions DROP CONSTRAINT page_revisions_parent_revision_id_fkey;
