-- Idempotency records (protocol section 8): scoped per principal, window 24 hours.
-- The key is stored as sent; the principal scope keeps two principals' keys apart.
CREATE TABLE idempotency_records (
  principal_id text NOT NULL,
  key          text NOT NULL,
  fingerprint  text NOT NULL,
  status       smallint NOT NULL,
  headers      jsonb NOT NULL,
  body         bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, key)
);
CREATE INDEX idempotency_records_created_idx ON idempotency_records (created_at);
