# ADR-0024: Workspace members and invite links

- **Status:** Accepted
- **Date:** 2026-10-26 (owner approval); written 2026-10-26
- **Deciders:** owner

## Context

ADR-0009 gave workspaces three roles (`owner`, `editor`, `viewer`) and the permission `administer`, but nothing used
it. Membership changed only through the server CLI (`add-member`). `GET /workspaces` showed the caller's role, a
member count and up to 50 members. There were no member or invite routes, no Members UI, and no email service.

On the hosted trial (ADR-0013, ADR-0014), people sign in with Google or GitHub through the sign-in broker. Signing up
creates the account and its own first workspace. Nobody could bring a second person into a workspace without the
operator running the CLI.

## Decision

The owner approved rules 1 to 5 on 2026-10-26. Rules 6 to 9 are how they are built.

1. **Members.**
   - Every member sees the member list: display names and roles, never emails.
   - Owners change a member's role (owner, editor or viewer) and remove members. Any member can leave.
   - A workspace always keeps at least one owner. The last owner cannot leave, be removed or be demoted; the refusal is
     409 `last_owner` with a clear message.
   - Making someone an owner still passes that account's owned-workspace quota (`maxWorkspacesPerAccount`).
   - Removal ends access at once: the account's next request to the workspace is 404, and share links it made stop
     working (ADR-0023 re-checks the creator on every view).
2. **Invite links.**
   - Owners create a link with:
     - a role, editor or viewer (owner only by promoting an existing member);
     - an expiry of 1, 7 or 30 days (default 7);
     - a number of uses, 1, 5 or 10 (default 1), never more than the member quota leaves room for.
   - The link is `https://<server>/i/<token>`.
   - Owners list the active links (role, uses left, expiry, created by) and revoke them.
   - Revoked, expired and used-up links are kept as records, like share links.
3. **Joining.**
   - The link opens a server-rendered page:
     - no script, the share page's CSP and headers;
     - light and dark, readable on a phone;
     - English or Thai, chosen from `Accept-Language`.
   - It shows the workspace name, the inviter's display name and the role, and "Sign in with … to join" through the
     existing broker.
   - After sign-in the browser comes back to a "Join workspace" form: a POST with CSRF protection, never a GET side
     effect. A new account made by signing in follows the normal trial rules.
   - After joining, the page offers "Open in Thoth" (the web client) and says how to add the server in the desktop app.
   - Someone already a member is told so; nothing changes, and a role is never downgraded.
   - The API and the desktop app join with `POST /api/v1/invites/accept` and the user's normal credential. In the
     desktop app this is Settings → Servers → "Join with an invite link": paste the link; Thoth adds and signs in to
     the server first if needed.
4. **Security.**
   - Tokens: at least 128 bits from a CSPRNG, URL-safe, only a hash stored, compared in constant time.
   - One 404 for unknown, malformed, expired, revoked, used-up and other servers' tokens.
   - Uses are counted atomically, under the workspace row lock, together with the member quota: two people joining
     with the last use, exactly one gets in.
   - Rate limits per client IP for opening and for accepting.
   - Only owners create, list or revoke: 403 for other members, 404 for non-members.
   - The invite page reveals only the workspace name, the inviter's display name and the role.
   - Every member, role and invite change is audited with its actor.
5. **Capabilities and limits.**
   - Two capabilities (ADR-0004): `members` (listMembers, setMemberRole, removeMember) and `invite-links`
     (createInviteLink, listInviteLinks, revokeInviteLink, acceptInvite, and the pages under `/i/`). Both are on by
     default; an operator switches invite links off with `INVITE_LINKS=off`, which leaves members management on.
   - The trial turns both on, with at most 20 active invite links per workspace (`MAX_INVITE_LINKS_PER_WORKSPACE`)
     plus the existing 10-member limit. Refusals are 409 `quota_exceeded` with `quota` (`inviteLinksPerWorkspace` or
     `membersPerWorkspace`), `limit` and `current`.
   - Clients hide what the server does not list.
6. **Tokens and storage.**
   - An invite token is made like a share token (ADR-0023 rule 6): 24 bytes (192 bits), base64url, SHA-256 stored,
     `timingSafeEqual`. It appears once, in the create response, so `createInviteLink` does not honour
     `Idempotency-Key`. Request logs show `/i/[token]`.
   - Migration `011_invites.sql`, additive only: tables `invite_links` and `invite_tickets`, and a nullable column
     `auth_requests.invite_id`. It is safe on the live database while the previous server build runs.
7. **Signing in from the invite page.**
   - The page starts a sign-in through the broker (`/i/<token>/sign-in?provider=…`). The auth request is marked with
     the client ID `thoth-invite` and the invite's ID. The provider's callback (the same registered address as every
     sign-in) finds the account by the usual rules, then issues **no** OAuth code, session or token. Instead it gives
     the browser a join ticket and returns to `/i/accept`.
   - The join ticket: 256 random bits in an HttpOnly, `SameSite=Lax` cookie (`__Host-thoth_join` on https), valid 15
     minutes, single use, stored as its SHA-256. It names the account and the invite.
   - `GET /i/accept` shows who is signed in and the join form (or "already a member").
   - `POST /i/accept` joins when all of these hold:
     - the ticket is live;
     - the form carries the value derived from the ticket (`SHA-256("thoth-invite-csrf\n" + ticket)`), compared in
       constant time;
     - the request comes from this origin: `Origin` equals `PUBLIC_URL`, or, when a browser sends `Origin: null`,
       `Sec-Fetch-Site: same-origin`.
   - The ticket is burnt in the same transaction as the join. A refusal (a full workspace) keeps it, so the form can be
     sent again.
   - The join form's page uses `Referrer-Policy: same-origin` (Chromium sends `Origin: null` on a form POST from a
     `no-referrer` page). No token is in that page's address. Every other invite page sends no referrer.
   - The invite pages' CSP is the share pages' with `form-action 'self'` instead of `'none'`, for the join form.
8. **One path for every join.** `acceptInvite` and the join form both:
   - lock the workspace row;
   - re-check the invite under `FOR UPDATE`;
   - check the member quota;
   - insert the membership, count the use, and audit `member.joined`.

   Every membership change takes the workspace row lock first and then reads the caller's role again. A role read
   before a wait could be stale, and with it two owners stepping down at once could leave none.
9. **What counts as an active link.** A link works while it is not revoked, not expired, not used up, **and its
   creator is still an owner**. A link carries its creator's authority, like a share link (ADR-0023 rule 3).

## Consequences

**Positive**

- An owner brings people into a workspace without the operator, on the trial too.
- The member list, roles and one owner are enforced by the server, under one lock, in every path (API, join form,
  CLI).
- The invite page needs no script, and its sign-in hands the browser no API credential.
- A database leak exposes no working invite link and no join ticket.

**Negative**

- Anyone holding the address can join, until it expires, is used up or is revoked. It can be forwarded.
- Joining from the invite page and then opening the web client means signing in twice: the join ticket is not a web
  session, on purpose.
- A removed member's open event stream ends at its next 30-second re-check, not at the same instant (the trial has no
  event streams).
- An owner who steps down silently stops the invite links they made.

**Follow-up work**

- Maintenance could remove long-dead invite rows.
- Email invitations (no email service exists).
- A "Join with an invite link" box in the web client (the server page covers the web for now).

## Alternatives considered

- **One capability `members-invites`.** Not chosen: an operator must be able to switch invite links off and keep
  members management.
- **A server-side web session for the invite page.** It would add a new long-lived credential. The single-use,
  15-minute join ticket does one thing only.
- **Sending "Sign in to join" to the web client with the token in its address.** The token would reach a second
  origin and its history. The owner asked for a server page.
- **A third public OAuth client for the invite page.** It would need a redirect URI and a token exchange for one POST.
  The broker already knows the account at the callback.
- **Refusing at create time only for the member quota.** The quota is also checked at join time, under the lock,
  because the CLI and other links add members too.
- **Clamping `maxUses` to the room left.** Not chosen: a clear 409 says why, and the dialog already offers only what
  fits.

## Spec references

- ADR-0004: capability negotiation.
- ADR-0009: roles, `administer`, audit.
- ADR-0013, ADR-0014: sign-in broker, trial limits.
- ADR-0023: share-link tokens, the single 404, rate limits before lookup, the creator re-check.
- docs/protocol/README.md sections 3, 4 and 10.

## Open questions

1. **Retention of dead invite links and audit rows.** They are kept, like share links.
2. **The desktop's place for "Join with an invite link".** The owner's brief named "Settings → Workspaces". The
   desktop has no such section: workspaces live under Settings → Servers, and the box is there.
3. **Owner as an invite role.** Left out by rule 2. Whether owners may later invite another owner directly is open.
