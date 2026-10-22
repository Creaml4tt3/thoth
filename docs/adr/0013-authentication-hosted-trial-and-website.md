# ADR-0013: Authentication (OIDC), a hosted trial server, and the project website

- **Status:** Accepted for rules 1–3 and 6 (owner decisions 2026-10-22: OIDC; a
  public trial server; a landing site that also runs Thoth in the browser).
  Rules 4–5 (quota values and hosting) are decided in ADR-0014, which also
  changes the token exchange in rule 1 to a server-side sign-in broker.
- **Date:** 2026-10-22
- **Deciders:** project owner

## Context

ADR-0004 left the authentication scheme open (OAuth 2.1 / OIDC versus session
tokens), and `docs/protocol/README.md` §4 marks bearer credentials as
provisional. The owner has now decided:

1. Sign-in uses **OIDC**.
2. There will be a **global server anyone can use**, limited like a trial.
3. There will be a **main website**: a landing page for the project where
   Thoth can also be used in the browser. No domain has been bought yet.

The spec lists "hosted SaaS" as out of MVP scope (section 13) while P2 includes
"Web client for connected workspaces". A free, limited trial instance of the
reference server is not a paid SaaS product, but it does change the threat
model: anyone on the internet can create an account.

The browser has no access to the Private Space (ADR-0008 rule 4); the web
client is for connected workspaces only.

## Decision

1. **OIDC for people, tokens for tools.**
   - The server is an OAuth 2.1 *resource server*. It does not store passwords.
     Users sign in with an external OpenID Connect provider (for example GitHub
     via an OIDC bridge, Google, Microsoft, or a self-hosted Keycloak/Authentik).
     A self-hosted server can list one or more issuers in configuration.
   - Desktop and web clients use the **Authorization Code flow with PKCE**
     (RFC 7636). Desktop uses a loopback redirect (RFC 8252); web uses a normal
     redirect back to the site. The server exchanges nothing on the client's
     behalf in v1: clients send the provider's access token or, where the
     provider's tokens are not JWTs, the server issues its own short-lived
     session token after verifying the ID token (decided in Phase 2b with
     tests; both paths keep `Authorization: Bearer`).
   - **Personal access tokens** remain for scripts, the conformance suite and
     single-person self-hosting. They are stored hashed and are revocable.
   - Sessions in the browser are not stored in `localStorage`. Browser SSE uses
     a short-lived, single-purpose stream ticket (not the access token in the
     URL), closing the `EventSource` question in protocol §4.
2. **One codebase.** The trial server is the reference server with a
   configuration switch, not a fork. Every limit is server-side and advertised
   through `GET /capabilities` `limits`, so clients can show them.
3. **The website is a separate static app, `apps/web`**, built from the same
   React UI packages as the desktop app:
   - a landing page (what Thoth is, download links, the open protocol, self-host
     instructions);
   - the web client at `/app`, which connects to any Thoth server the user
     names and defaults to the trial server;
   - static files only, so it can be hosted for free without a domain (for
     example GitHub Pages at `<owner>.github.io/thoth`, or Cloudflare Pages)
     and moved to a custom domain later by changing configuration.
   The server allows the website's origin through an explicit CORS allow-list.
4. **Trial limits (Proposed values, adjustable by configuration):** one
   workspace per account, up to 3 members, 500 pages, 50 MB attachments, 5 MB
   per attachment, revisions kept 30 days, rate limits per account and per IP,
   accounts inactive for 90 days are deleted after an email notice where the
   provider supplies an email. Exceeding a limit returns a protocol error with
   a clear message; it never silently drops data.
5. **Trial operations (Proposed):** the trial server shows on every surface
   that it is a trial with no uptime or retention guarantee; users can export
   everything at any time (Workspace → Private transfer, ADR-0006). Abuse
   controls before public launch: sign-up only through OIDC providers, per-IP
   account creation limits, upload MIME and size checks, and a way to suspend
   an account. Where it is hosted (and who pays) is not decided.
6. **Containers run with Podman.** The reference deployment is a Compose file
   that works with `podman compose` (spec section 11 asks for Docker Compose;
   the same file format serves both). Tests that need PostgreSQL start it with
   Podman.

## Consequences

- Positive: no passwords to store or leak; third-party servers can use their own
  identity provider; the trial server and self-hosted servers behave the same.
- Positive: the website needs no server of its own and no domain to start.
- Negative: OIDC needs a registered client per provider and per site origin; a
  local-only self-hoster without an identity provider uses personal access
  tokens instead.
- Negative: a public trial needs abuse handling, monitoring and a privacy
  policy before launch. These are operational, not code, and are listed as
  launch blockers.
- Follow-up: Phase 2b (OIDC verification, sessions, stream tickets, quotas,
  CORS) and Phase 2c (`apps/web`: landing page and web client), each with its
  own acceptance tests in `docs/architecture/implementation-plan.md`.

## Alternatives considered

- **Server-managed passwords and sessions.** Rejected by the owner: every server
  would hold password hashes and need reset flows.
- **A separate trial service.** Rejected: two codebases drift; limits belong in
  configuration.
- **Server-rendered website.** Not needed: static hosting is free and works
  without a domain.

## Spec references

Section 2 (open protocol, reference server), 3.2, 8, 11, 12 (browser sessions,
abuse), 13 (P2 web client; hosted SaaS out of scope).

## Open questions

- ~~Which OIDC providers first.~~ Decided in ADR-0014: Google, then GitHub
  (through a server-side adapter, not an OIDC bridge).
- ~~Trial limit values and hosting (rules 4–5).~~ Decided in ADR-0014.
- Privacy policy, terms and an abuse contact: drafted in `docs/legal/`; the
  owner's contact address is still needed before the trial launches.
- The product name may still change (name clash with an existing app). Blocks
  buying a domain and the final website copy, not the build.
