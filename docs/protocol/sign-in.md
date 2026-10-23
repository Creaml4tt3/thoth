# Sign-in broker (reference server)

Status: Phase 2b part 2, implementing ADR-0014 rule 4. This is how Thoth's own
clients (desktop, web) obtain the bearer credential that protocol §4 asks for.
It is optional: a server that does not configure any provider does not
advertise it, and personal access tokens keep working everywhere.

The server plays two OAuth roles at once:

- an **authorization server** for Thoth clients (Authorization Code + PKCE,
  RFC 6749, RFC 7636, RFC 8252 for desktop);
- a **confidential OAuth client** of each upstream provider (Google through
  generic OpenID Connect, GitHub through an OAuth 2.0 adapter).

Provider secrets and provider tokens never leave the server, and are never
stored or logged. Clients only ever talk to Thoth.

## 1. Discovery

`GET /api/v1/capabilities` gains an optional member when at least one provider
is configured:

```json
"signIn": {
  "authorizationEndpoint": "https://api.example.org/auth/authorize",
  "tokenEndpoint": "https://api.example.org/auth/token",
  "revocationEndpoint": "https://api.example.org/auth/revoke",
  "providers": [{ "id": "google", "name": "Google" }, { "id": "github", "name": "GitHub" }]
}
```

URLs are absolute, built from `PUBLIC_URL`. The member is additive; protocol
stays 1.0.

## 2. Clients

There is no dynamic registration. Two public clients exist:

| `client_id` | Redirect URIs accepted | Refresh token goes to |
| --- | --- | --- |
| `thoth-desktop` | `http://127.0.0.1:<any port>/callback` and `http://[::1]:<any port>/callback` (RFC 8252 §7.3: any port; `localhost` is not accepted) | the response body (the app keeps it in the OS keychain) |
| `thoth-web` | exactly one of `WEB_REDIRECT_URIS` (e.g. `https://thoth.creaml4tt3.me/app/callback`); not available when unset | an `HttpOnly` cookie, never the body |

Redirect URIs are compared as exact strings after the rules above. No
wildcards, no prefix matching, no fragments.

## 3. Authorization request

`GET /auth/authorize` with query parameters:

| Parameter | Rule |
| --- | --- |
| `response_type` | `code` |
| `client_id` | a client from §2 |
| `redirect_uri` | allowed for that client |
| `code_challenge` | 43 to 128 characters of `[A-Za-z0-9._~-]` |
| `code_challenge_method` | `S256` (`plain` is refused) |
| `state` | required, 1 to 512 printable ASCII characters, returned unchanged |
| `provider` | optional; one of the advertised provider IDs |

Errors:

- An unknown `client_id`, a disallowed or missing `redirect_uri`: **400 HTML
  page**, never a redirect (the target is not trusted yet).
- Any other invalid parameter, with a trusted `redirect_uri`: redirect to it
  with `error=invalid_request` (or `unsupported_response_type`) and `state`.

Without `provider` and with more than one provider configured, the server
answers a small HTML page, "Continue with Google / Continue with GitHub". Each
link is the same request plus `provider`. With one provider it goes straight on.

With a provider, the server:

1. stores an **auth request** for 10 minutes: client, redirect URI, challenge,
   client state, provider, and its own upstream `state` (stored hashed), PKCE
   verifier and OIDC `nonce`;
2. sets a short-lived, `HttpOnly`, `SameSite=Lax` cookie on its own origin
   (`__Host-thoth_signin`, or `thoth_signin` on plain `http`) holding a random
   binding value (stored hashed with the request), so the callback must arrive
   in the browser that started the sign-in;
3. redirects (302) to the provider's authorization endpoint with its own
   `state`, `code_challenge` (S256), `nonce` (OIDC), and
   `redirect_uri = PUBLIC_URL + /auth/callback/<provider>`. Scopes are `openid
   email profile` (OIDC) or `read:user user:email` (GitHub).

## 4. Provider callback

`GET /auth/callback/<provider>?code&state` (or `?error&state`).

1. Find the auth request by the hash of `state`. Consume it atomically: one
   request can complete at most once. It must be unexpired, for this provider,
   and the binding cookie must match. If anything fails, answer an **HTML
   page** saying the sign-in link expired or is invalid. No redirect, because
   the client is not known for sure.
2. If the provider returned `error`, redirect to the client with
   `error=access_denied` and the client's `state`.
3. Exchange the code at the provider with the client secret and PKCE verifier.
   - **OIDC:** verify the ID token: signature against the issuer's JWKS from
     discovery, an asymmetric algorithm only (`none` and `HS*` are refused),
     `iss` equals the configured issuer, `aud` contains the client ID (`azp`
     equals it when there are several audiences), `exp`, `iat` with 60 s
     tolerance, `nonce` equals the stored nonce, `sub` present. The email is
     used only when `email_verified` is `true`. Discovery's `issuer` must equal
     the configured issuer. For Google only, `iss` may also be
     `accounts.google.com` (no scheme), which Google documents.
   - **GitHub:** `GET /user` gives the stable numeric `id` (the subject),
     `login` and `name`. `GET /user/emails` gives the email: the primary one,
     and only when verified.
   - The provider's access token is used for these calls only, then dropped.
4. Find the account by **(provider, subject)**, never by email. A new account
   is created only after these checks:
   - the per-IP sign-up limit (`SIGNUP_LIMIT_PER_IP` per 24 h, counted in a
     `sign_ups` table that keeps only a hash of the address, for one day);
   - the server-wide account cap (`MAX_ACCOUNTS`).

   When either limit is reached, redirect with `error=access_denied` and an
   `error_description` saying the server is not accepting new accounts.

   A new account also gets **one workspace it owns**, in the same
   transaction: "<display name>'s workspace", or "My workspace" when the
   provider gave no name (or only an email address). The protocol has no way
   to create a workspace, so without it a new user would sign in to nothing.
   It counts toward `MAX_WORKSPACES_PER_ACCOUNT`; if that limit is somehow
   already reached, the sign-up is refused like the other two and nothing is
   created. Existing accounts are never given one.
5. Issue an **authorization code**: random, stored hashed, valid 60 s, single
   use, bound to client, redirect URI, PKCE challenge and account. Redirect to
   the client's redirect URI with `code`, the client's `state`, and `iss`
   (RFC 9207, the server's `PUBLIC_URL`).

A failure while talking to the provider, or a token that fails verification,
redirects with `error=server_error` or `error=access_denied` respectively. It
is logged without any token, code or secret.

## 5. Token endpoint

`POST /auth/token`, `Content-Type: application/x-www-form-urlencoded`.
Responses are OAuth JSON (RFC 6749 §5), not problem documents. Every response
carries `Cache-Control: no-store`.

**`grant_type=authorization_code`** needs `code`, `redirect_uri`, `client_id`
and `code_verifier`.

An unknown `client_id` (here and at `/auth/revoke`) is 400 `invalid_client`
and does not touch the code. Otherwise the code row is locked and **burned on
every attempt**: success or any mismatch.

These are `invalid_grant`:
- an unknown or expired code;
- another client;
- a different redirect URI;
- a failed PKCE check: `BASE64URL(SHA256(code_verifier)) ≠ challenge`, or a
  verifier that is not 43 to 128 unreserved characters.

**A replayed code** (already used) is `invalid_grant`, and it also revokes the
session that the first use created (RFC 6749 §4.1.2).

Success creates a **session**, and returns:

```json
{ "access_token": "thoth_at_…", "token_type": "Bearer", "expires_in": 900, "refresh_token": "thoth_rt_…" }
```

For `thoth-web`, `refresh_token` is not in the body. It is set as a cookie:

- name `__Secure-thoth_refresh` (`thoth_refresh` when `PUBLIC_URL` is plain
  `http`);
- `HttpOnly; Secure; SameSite=Strict; Path=/auth`;
- `Max-Age` = the refresh lifetime.

**`grant_type=refresh_token`** needs `client_id`.
- `thoth-desktop` sends `refresh_token` in the body.
- `thoth-web` sends no `refresh_token` in the body (sending one is
  `invalid_request`): the cookie is used. The request must
  also carry an `Origin` from `CORS_ORIGINS`, or it gets `invalid_request`.
  This is CSRF protection on top of `SameSite`.

The refresh token row is locked.

- **Unknown, expired, another client's, or of a revoked session:**
  `invalid_grant`.
- **Already used (reuse):** `invalid_grant`, and the whole session is revoked:
  every refresh and access token of that family. It is audited as
  `auth.refresh_reuse`. Two refreshes racing with the same token count as
  reuse: clients must refresh one at a time.
- **Otherwise:** the token is marked used and a new pair is issued, with the
  same session and a new refresh expiry.

Lifetimes:

| Item | Lifetime | Setting |
| --- | --- | --- |
| Access token | 15 minutes | `ACCESS_TOKEN_TTL_SECONDS` (60 to 3600) |
| Refresh token | 30 days, sliding | `REFRESH_TOKEN_TTL_DAYS` (1 to 365) |
| Session | at most 90 days from sign-in, then sign in again | `SESSION_MAX_DAYS` |

Access tokens are opaque, stored as SHA-256 like personal access tokens (in the
same table, linked to the session), and sent as `Authorization: Bearer`. The
`/api/v1` routes do not change. Revocation takes effect on the next request.

## 6. Revocation (sign out)

`POST /auth/revoke` (RFC 7009), form-encoded, takes `token` and `client_id`.
- The token may be a refresh or an access token.
- `thoth-web` may send no `token`: the cookie is used, with the same `Origin`
  rule as refresh.

The token's session is revoked. Always `200`, also for unknown tokens. For
`thoth-web` the cookie is cleared.

## 7. Browser rules

- CORS: `/auth/token` and `/auth/revoke` follow `CORS_ORIGINS` like `/api/v1`,
  with credentials allowed. `/auth/authorize` and the callbacks are top-level
  navigations and need no CORS.
- HTML pages (chooser, errors) send:
  - `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;
  - `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

  Every interpolated value is HTML-escaped.
- `Referrer-Policy: no-referrer` is also sent on every redirect, so codes are
  not leaked through referrers.

## 8. Rate limits and housekeeping

- `/auth/*` counts against the per-IP limit like `/api/v1`.
- The daily maintenance job deletes:
  - expired auth requests and codes;
  - refresh tokens and session access tokens that expired more than a day ago;
  - sessions that are revoked or past their maximum age.
- `users.last_seen_at` is updated at sign-in and refresh (at most once an hour).
  It feeds the 90-day inactivity rule, whose deletion job is not built yet
  (ADR-0014 open question on email).

## 9. Configuration

| Variable | Meaning |
| --- | --- |
| `PUBLIC_URL` | The server's public origin, e.g. `https://api.thoth.creaml4tt3.me`. Required when any provider is set. |
| `OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET` | Google (issuer `https://accounts.google.com`). |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | Any other OIDC issuer (Keycloak, Authentik…), provider ID `oidc`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth App. |
| `GITHUB_URL`, `GITHUB_API_URL` | GitHub Enterprise or a test double (default `https://github.com`, `https://api.github.com`). |
| `WEB_REDIRECT_URIS` | Comma-separated exact redirect URIs for `thoth-web`. |
| `SIGNUP_LIMIT_PER_IP` | New accounts per IP per 24 h (trial: 10; default: unlimited). |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`, `SESSION_MAX_DAYS` | Lifetimes, §5. |

Other rules:
- Issuer URLs must be `https`, except loopback hosts, which are allowed for
  local test issuers.
- A provider is enabled only when both its ID and its secret are set; setting
  only one is a configuration error.
- Secrets are never echoed in errors or logs.
