# ADR-0023: Public read-only share links for workspace pages

- **Status:** Accepted
- **Date:** 2026-10-25 (owner approval); written 2026-10-26
- **Deciders:** owner

## Context

People want to show a workspace page to someone who has no Thoth account: a client, a reviewer, a friend reading on
a phone. ADR-0009 left "guest and public links" open. Today the only way out is a transfer or a copy-paste, and both
lose the page as soon as it changes.

Opening a page to the public internet carries risks:

- The token is a bearer secret.
- The page's Markdown is user content that must not run in a browser.
- The workspace around the page (other pages, members, IDs) must stay closed.
- The hosted trial (ADR-0014) has small, shared resources.

## Decision

The owner approved rules 1 to 5 on 2026-10-25. Rules 6 to 8 are how they are built.

1. **What.** One workspace page can be shared read-only at `https://<server>/s/<token>`.
   - Its sub-pages (the page's subtree) come along, at `/s/<token>/p/<pageId>`.
   - The attachments those pages use come along, at `/s/<token>/a/<attachmentId>`.
   - Nothing else of the workspace is reachable.
   - The viewer cannot edit or comment, and does not sign in.
2. **Who creates.** Workspace owners and editors can share; viewers cannot. Creating, listing and revoking are
   protocol calls (`createShareLink`, `listShareLinks`, `revokeShareLink`) with the user's normal authentication.
3. **Expiry and revoke.**
   - Expiry: 7, 30 or 90 days, or never. The default is 30.
   - A link can be revoked at any time.
   - A link stops working when its page is deleted or moved out of the workspace (a transfer move deletes the page
     there), or when its creator is no longer an owner or editor.
   - It always shows the page's current revision, not a snapshot.
   - Responses carry `X-Robots-Tag: noindex, nofollow` and a matching `<meta name="robots">`.
4. **Trial and self-hosting.**
   - The feature is the optional capability `public-share` (ADR-0004). It is on by default on every server.
   - A self-hosted operator can switch it off (`PUBLIC_SHARE=off`) and set limits by configuration:
     - `MAX_SHARE_LINKS_PER_WORKSPACE`;
     - `SHARE_VIEWS_PER_LINK`;
     - `SHARE_VIEWS_PER_IP`.
   - The trial keeps it on, with at most 20 active links per workspace and view limits of 300 per link and 120 per IP
     per minute.
   - A refusal past a limit is a clear problem response: 409 `quota_exceeded` with `quota: shareLinksPerWorkspace`,
     or 429 `rate_limited` with `Retry-After`.
   - Clients hide the feature when the server does not list the capability.
5. **Rendering.** The server renders plain HTML from the Markdown.
   - There is no script at all.
   - The CSP is `default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none';
     base-uri 'none'; form-action 'none'`, together with `Referrer-Policy: no-referrer` and
     `X-Content-Type-Options: nosniff`.
   - Raw HTML in the Markdown is escaped, never passed through.
   - Links to pages of the shared subtree go to their share address. `thoth:` links and wikilinks outside it become
     plain text. External links get `rel="noopener noreferrer nofollow"`.
   - Attachments are served under the token with their stored type and a safe `Content-Disposition`. SVG is never
     inline (download only).
   - Light and dark follow `prefers-color-scheme`, with the brand's tokens and fonts served by the server. The page
     is readable on a phone.
6. **Tokens.**
   - A token is 24 bytes (192 bits) from the operating system's CSPRNG, base64url (32 characters).
   - Only its SHA-256 is stored, and the check is constant time (`timingSafeEqual`).
   - The token appears once, in the create response. `createShareLink` therefore does not honour `Idempotency-Key`,
     because a stored replay would keep it. A listed link cannot be copied again; the user makes a new one.
   - Request logs show `/s/[token]`.
7. **One answer for every failure.**
   - These all get the same 404, with the same body and headers: an unknown, malformed, expired or revoked token, a
     page or attachment outside the subtree, a demoted creator, a deleted page, and the capability switched off. The
     body is HTML for a browser and problem+json otherwise.
   - The link is resolved by one SQL statement of one shape whatever the outcome.
   - Rate limits run before that lookup and count the token as given (its hash), so a 429 does not tell whether a
     token exists.
   - Every request re-checks the link from the database, scoped by the link row (its workspace and root page), never
     by IDs from the URL alone.
8. **Not shown.** A share page never contains:
   - workspace IDs or names;
   - member names or emails;
   - titles of pages outside the subtree. A `thoth:` link to such a page shows only its own label, or "a page that is
     not shared".

## Consequences

**Positive**

- A page can be read anywhere, also on a phone, without an account. Revoking a link takes effect at once.
- The share surface is small and fixed: three protocol calls, three GET routes, a stylesheet and three fonts.
- No HTML from a page ever reaches a browser.
- A database leak exposes no working link, because only hashes are stored.

**Negative**

- Anyone who has the address can read the page until it expires or is revoked. The address can be forwarded, and
  search engines are asked, not forced, to stay away.
- The rendering is the server's own allowlist over mdast. Embeds, callout styling, math and diagrams show as their
  text or as plain blocks.
- A listed link cannot be copied again.
- Each view reads the subtree and the page. Pictures are checked against the subtree's Markdown on every request,
  which is extra work for the database.

**Follow-up work**

- Maintenance could remove long-expired and revoked rows.
- Possibly per-page view counts, or a "who can see this" note in the page header.
- Richer rendering, such as callouts and embedded sub-pages.

## Alternatives considered

- **Signed, stateless tokens (HMAC with an expiry).** Revocation, demotion and deletion need server state anyway, and
  a signing-key leak would open every page. Not chosen.
- **A snapshot at share time.** The owner chose the current revision. A snapshot would also need its own storage and
  retention.
- **Rendering in the web client (the SPA) instead of the server.** It would need script, a looser CSP, and the
  protocol's authenticated routes opened to anonymous callers. Not chosen.
- **A Markdown-to-HTML library with a sanitizer (remark-rehype and rehype-sanitize).** It would add new dependencies
  for less control. The repository's own parser (`@thoth/content`) with an allowlist renderer covers what Thoth pages
  contain.
- **Per-link rate-limit keys by link ID.** Only existing tokens would ever be limited, so a 429 would tell an attacker
  the token is real. Keys use the token hash instead.

## Spec references

- ADR-0004: capability negotiation.
- ADR-0009: authorization and sharing; this ADR settles "public links" from its open questions.
- ADR-0014: trial limits.
- docs/protocol/README.md section 10.

## Open questions

1. **Export-restricted workspaces.** The implementation refuses to create a link in a workspace with ADR-0009's
   export restriction (403 `export_restricted`), and links stop working if the restriction is switched on later. The
   reason is that a public link takes content out of the workspace. The owner's rules do not mention this case.
   Confirm it, or allow links there.
2. **Language of the page chrome.** The words around the content ("Shared page · read-only", "Pages inside", the 404
   text) are English only. Choosing a language by `Accept-Language` is open.
3. **Retention of revoked and expired links.** They are kept, as a record of what was public. Whether maintenance
   should remove them, and after how long, is open.
