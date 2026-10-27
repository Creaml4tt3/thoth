-- Feedback from users (ADR-0033, capability `feedback`): a problem, an idea or a question from the desktop app, the web
-- client or the website's support page. No sign-in is needed. What is kept: the kind, the message, the email address the
-- person chose to give, the client's short description of itself (client, version, os, language) when they left it on,
-- the account of a valid credential, and a salted SHA-256 of the client address, used only to rate limit. Never the
-- address itself, and never page text, titles or file names (the protocol's request body is strict).
--
-- Additive only (two new tables), so it is safe to apply to a live database while an older server build runs: older
-- builds never read them. Production runs with MIGRATE_ON_START=false: apply this migration (`node src/cli.ts migrate`,
-- direct URL) before deploying a server build that lists `feedback`.
CREATE TABLE IF NOT EXISTS feedback (
  -- UUIDv7, made by the server.
  id         uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL CHECK (kind IN ('problem', 'idea', 'question')),
  message    text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000),
  email      text CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
  context    jsonb CHECK (context IS NULL OR jsonb_typeof(context) = 'object'),
  -- The account of a valid credential that came with it. When the account is deleted the feedback stays, without it.
  account_id text REFERENCES users (id) ON DELETE SET NULL,
  ip_hash    text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$')
);

-- `feedback list --since` and `feedback export`, newest first.
CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC, id DESC);

-- The salt of the address hashes: one random value per database, made here, never sent anywhere. Two gen_random_uuid()
-- values (built in since PostgreSQL 13, from a strong random source) give 244 random bits.
CREATE TABLE IF NOT EXISTS feedback_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ip_salt   text NOT NULL CHECK (char_length(ip_salt) >= 32)
);
INSERT INTO feedback_settings (ip_salt)
VALUES (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
ON CONFLICT (singleton) DO NOTHING;
