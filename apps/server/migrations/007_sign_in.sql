-- Sign-in broker (docs/protocol/sign-in.md). Every secret the server issues (state, binding, codes, tokens)
-- is stored only as its SHA-256. The upstream PKCE verifier and nonce live in plain text for the 10 minutes
-- of one auth request and are nulled when it is consumed.

-- Feeds the inactivity rule (ADR-0014). Updated at sign-in and refresh, at most once an hour.
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

-- An account is keyed by (provider, provider subject), never by email.
CREATE TABLE identities (
  provider   text NOT NULL,
  subject    text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user_idx ON identities (user_id);

-- One sign-in of one client. Revoking it revokes every token of the family.
CREATE TABLE sessions (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id  text NOT NULL CHECK (client_id IN ('thoth-desktop', 'thoth-web')),
  provider   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The maximum age (SESSION_MAX_DAYS): refresh never extends a session past it.
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- A sign-in in progress, between /auth/authorize and the provider callback. Single use, 10 minutes.
CREATE TABLE auth_requests (
  state_hash     text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  binding_hash   text NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  provider       text NOT NULL,
  client_id      text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  client_state   text NOT NULL,
  pkce_verifier  text,
  nonce          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  CHECK (consumed_at IS NULL OR (pkce_verifier IS NULL AND nonce IS NULL))
);
CREATE INDEX auth_requests_expires_idx ON auth_requests (expires_at);

-- Our authorization codes: 60 s, single use, bound to client, redirect URI, PKCE challenge and account.
-- `session_id` is set by the first redemption, so a replay can revoke what it created.
CREATE TABLE auth_codes (
  code_hash      text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  user_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id      text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  provider       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  session_id     text REFERENCES sessions (id) ON DELETE SET NULL
);
CREATE INDEX auth_codes_expires_idx ON auth_codes (expires_at);

-- Rotating refresh tokens. A used token presented again revokes its whole session.
CREATE TABLE refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  session_id text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- Session access tokens share the personal-access-token table, so the /api/v1 authenticator is unchanged.
ALTER TABLE access_tokens ADD COLUMN session_id text REFERENCES sessions (id) ON DELETE CASCADE;
CREATE INDEX access_tokens_session_idx ON access_tokens (session_id) WHERE session_id IS NOT NULL;

-- New accounts per client IP (SIGNUP_LIMIT_PER_IP per 24 h). The address is stored only as a SHA-256
-- and the row is removed by maintenance after a day.
CREATE TABLE sign_ups (
  ip_hash    text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_ups_ip_idx ON sign_ups (ip_hash, created_at);
