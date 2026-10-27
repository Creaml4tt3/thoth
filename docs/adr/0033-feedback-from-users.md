# ADR-0033: Feedback from users, in the apps and on the website

- **Status:** Proposed
- **Date:** 2026-10-27
- **Deciders:** owner (the decision below); implementation agent (the rules marked as its choices)

## Context

People who try Thoth need a way to report a problem, suggest an idea or ask a question. The GitHub repository is
private, so public issues are not an option yet. Email works but asks a lot of someone who is in the middle of the app.
The reference server (`apps/server`) already runs for the hosted demo, already has rate limiting in PostgreSQL, CORS
for the site and the web client, and an admin CLI. Thoth's privacy rules (ADR-0007 rule 7, ADR-0015) say no page text,
titles or names leave the device without the person choosing it. The desktop app contacts no server the person has not
added (ADR-0014). Another change is moving the addresses to a new domain, so no host may be written into the code.

## Decision

1. **One endpoint, three forms.** `POST /api/v1/feedback` (operation `sendFeedback`, capability `feedback`) on the
   workspace server. The desktop app, the web client and the website's `/support/` page (and `/th/support/`) send to
   it. A mail link to the contact address stays on every form as the fallback. When the repository is public, the
   forms can link to issues as well.
2. **The body is strict:** `kind` (`problem` | `idea` | `question`), `message` (1 to 5000 characters, not blank),
   optional `email` (valid, at most 254), optional `context` `{ client: desktop|web|site, version?, os?, language? }`
   (short, validated strings), and the website's honeypot `website`. Unknown members are refused (400), so nothing
   else can ride along. The forms say that only what is typed is sent, never pages, titles or file names.
3. **No sign-in needed.** A valid bearer credential ties the feedback to that account; an invalid one is ignored, never
   401. OpenAPI marks the route `security: [{}, {bearerAuth: []}]`.
4. **Storage:** migration `013_feedback.sql`, table `feedback` (id UUIDv7 made by the server, created_at, kind,
   message, email, context jsonb, account_id null, ip_hash). `ip_hash` is the HMAC-SHA-256 of the client address with
   a random salt the migration makes in `feedback_settings` (one per database, never sent). The address itself is not
   stored by this feature. The answer is 204 with no body.
5. **Rate limits** per address hash and per account: 5 per 10 minutes and 30 per day, on top of the server's general
   per-IP and per-account limits. A refusal is 429 `rate_limited` with `Retry-After`. Order: validate, honeypot, count,
   store, so a refused request stores no feedback.
6. **Honeypot:** a filled-in `website` gets the same success answer and is not stored or counted.
7. **CORS:** the origins the server already allows (`CORS_ORIGINS`). No new configuration.
8. **The website form needs no JavaScript** (implementation choice, the simpler of the two the owner offered): a
   plain form-encoded POST to `<API_URL>/api/v1/feedback`. The server accepts it only with an `Origin` in
   `CORS_ORIGINS` (or its own `PUBLIC_URL`), else 403, and answers with its own small HTML page (thanks, what to fix, or
   too many messages) in the form's language, with a link back to the `return` path on that origin. The site stays
   static. Its `API_URL` comes from the site's build config (`API_URL`, else the web client's `VITE_DEFAULT_SERVER`,
   else `api.` + the site's host). No analytics event is attached to the form.
9. **Desktop target** (implementation choice): the demo server (`starterServer`) once the person has added it, signed
   in or not, if it lists `feedback`; else the first signed-in server that lists it; else the dialog says no server can
   take it and shows the address. A server that was never added is never contacted. Calls go through the host
   (`api.call`); the webview still has no network (ADR-0008). The host's `link.open` takes web links only (ADR-0020),
   so the desktop shows the email address with a Copy button instead of a `mailto:` link.
10. **Web target:** the web client's one server, when it lists `feedback`; otherwise the dialog and command are absent.
11. **The dialog** (shared, `packages/app-ui/src/feedback/FeedbackDialog.tsx`): the three kinds as a radio group, the
    message, an optional email, "Include the app version and system" on by default with exactly the values it adds on
    screen. Errors are under their fields (`aria-invalid`, `aria-describedby`) and the first takes the focus; the result
    is a live region. In Settings ("Help and feedback", in the section list) and the palette ("Send feedback…").
12. **Reading it:** `node src/cli.ts feedback list [--since <date|7d|12h>]` and `feedback export --json`. Control
    characters typed by strangers are escaped in both outputs, so a message cannot drive the terminal. The address hash
    is not shown.
13. **Switch:** `FEEDBACK=off` drops the capability; the route is then 501 and the apps hide the forms.

## Consequences

- Positive: one place to read feedback; works for people without an account; no third-party form service; nothing
  from the notes leaves the device; the site stays static.
- Negative: the operator reads feedback with the CLI only (no UI); there is no retention limit yet (rows stay until
  deleted by hand); the rate limit counters keep a hash, but the server's general per-IP limiter already keys on the
  raw address in `rate_limits` (unchanged here). A spammer with many addresses can still send 5 per 10 minutes each.
- The website's support page depends on the API's origin being in `CORS_ORIGINS` and on migration 013 being applied
  before a build that lists `feedback` is deployed (production runs with `MIGRATE_ON_START=false`).
- The conformance suite checks only refusals (`feedback.refusals`), so a run never leaves feedback on a server.

## Alternatives considered

- **Progressive enhancement with `fetch` on the site:** needs `connect-src` for the API in the site's CSP and a script;
  the plain POST does the job with neither.
- **A mail-only form (mailto):** kept as the fallback, but it needs a mail client and loses the structure.
- **A hosted form service:** sends what people type to a third party; ruled out by the privacy notice.
- **Public GitHub issues:** not possible while the repository is private.

## Spec references

Section 8 (protocol endpoints, extended), section 10 (server), ADR-0004 (capabilities), ADR-0008 (no network in the
webview), ADR-0014 (the demo server is contacted only when added), ADR-0015 (site and analytics), ADR-0020 (link.open).

## Open questions

- Retention: how long feedback is kept, and whether `maintenance` should purge old rows. Blocks nothing.
- Whether the privacy notice should name feedback explicitly (what is kept, for how long). Needs the owner.
- A reply flow (answering from the CLI by email) is out of scope.
