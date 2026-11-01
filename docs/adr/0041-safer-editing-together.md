# ADR-0041: Safer editing together: change notices, presence and live updates

- **Status:** Proposed
- **Date:** 2026-11-01
- **Deciders:** owner (option A: notices, presence and live hints now; live co-editing later); implementation agent (the
  rest, marked "(this ADR)")
- **Extends:** ADR-0005 (revisions and conflicts), ADR-0004 (capabilities; SSE is a hint). **Defers:** the
  `realtime-collab` capability.

## Context

Several people can edit one workspace page. Every write is compare-and-swap on a revision (ADR-0005): a stale write is
412 `revision_conflict`, and the client shows the conflict dialog (Keep mine, Keep theirs, Keep both). Nothing is lost,
but three gaps remained:

- A page open with no unsaved edits reloaded **silently** when someone else changed it, so a person could miss that
  the text in front of them had just been replaced (for example by someone's "Keep mine").
- A page open **with** unsaved edits learned of the change only at its next save, after the person had typed more on
  a stale version.
- Nobody could see who else had the page open, so two people started editing the same page without knowing.

Other people's changes reach an open page through the change feed, polled every 5 seconds while the window is visible.
The reference server has had server-sent change hints (`events.sse`, `ChangeHub` over LISTEN/NOTIFY) since Phase 2,
but no client used them. The hosted demo runs on Vercel with `EVENTS=off` (ADR-0014: it cannot hold connections), so
polling stays the fallback. Live co-editing (a CRDT such as Yjs) is a separate, later project.

## Decision

### Change notices

1. **No silent reload of a shared page.** When an open workspace page with no unsaved edits reloads because the page
   changed on the server, the page shows "Updated by <name> just now." with a Dismiss button. The name is the new
   revision's `authorId`, looked up in the workspace's member preview or in presence; "Updated on the server just now."
   when it is not known. A change by the person's own account (another window, or a rename from the sidebar) shows no
   notice. The notice goes when the person dismisses it or types. There is no revision-history view in the apps yet,
   so the notice has no link to the previous version (see Open questions).
2. **Unsaved edits meet the change at once.** When the change feed reports a new revision of an open workspace page
   that has unsaved edits, the conflict dialog opens right away (before the next save) and the editor stops taking
   input, so nothing more is typed on a stale version. Nothing is written until the person chooses. The dialog and its
   three choices are unchanged (ADR-0005 rule 4).
3. Whoever's text was replaced is therefore always told: by the notice (rule 1) when they had no unsaved edits, by
   the dialog (rule 2) when they had.

### Presence (capability `presence`)

4. **Two routes.** `PUT /workspaces/{id}/pages/{pageId}/presence` (no body) says the caller has the page open and
   answers `{ items: [{ userId, displayName }] }`: the other members who have it open now, never the caller, at most
   50. `DELETE` on the same path says the caller left (204, also when there was nothing to remove). Both are for any
   member who can read the workspace, viewers too; a non-member, an unknown and a deleted page are 404, like every
   other workspace route (ADR-0009).
5. **Heartbeats with a short lifetime.** A client sends the heartbeat when a page opens and every 15 seconds
   (`PRESENCE_HEARTBEAT_SECONDS`) while the page is shown and the window is visible, and the leave when the last view
   of the page closes. The server forgets a heartbeat 45 seconds (`PRESENCE_TTL_SECONDS`) after it arrived, so a
   closed laptop or a lost leave clears itself.
6. **Kept in Postgres** (this ADR): table `page_presence` (migration `015_presence.sql`, additive), one row per
   workspace, page and account with `seen_at`. A heartbeat upserts its row, deletes the page's expired rows and reads
   the live ones; `maintenance` deletes expired rows everywhere. It works on the stateless demo exactly as on a
   self-hosted server, with no new infrastructure.
7. **Nothing but a name and an ID.** An entry is the member's opaque user ID (the same ID as `actorId` and the member
   list's `userId`) and display name. Never an email, the device, the client's address or what the person is typing.
   A member removed from the workspace stops showing at once (the read joins current memberships).
8. **Shown in the page header** of both the desktop app and the web client: up to three initials and "Ana is also
   here" / "Ana and Ben are also here" / "Ana, Ben and 2 others are also here", in a `role="status"` region.
9. **Capability-gated.** The server lists `presence`; a client sends nothing to a server that does not list it, and
   shows no one. A server that does not list it answers the routes 501 `capability_not_supported`.

### Live change hints

10. **SSE where the server and the host can.** For each workspace with an open page, a client whose server lists
    `events.sse` and whose host can stream opens `GET /workspaces/{id}/events`. A `changes` hint reads the change feed
    at once, through the same code path as the poll (one read at a time per workspace; a hint during a read makes one
    more read after it). The hint's payload is never read (ADR-0004: a hint is not data).
11. **The poll is the fallback.** While a workspace's stream is up it is not polled. When the stream ends or fails,
    that workspace goes back to the 5-second poll at once, and the stream is opened again after 5 seconds, doubling
    up to 60 seconds. A server without `events.sse` (the demo), a hidden window and a host that cannot stream all poll
    as before.
12. **Web client** (this ADR): the stream is read with `fetch` and a `ReadableStream`, not `EventSource`, so the bearer
    token stays in the `Authorization` header and never goes into a URL. A 401 renews the token once, as every other
    request does.
13. **Desktop app** (this ADR): keeps polling. Its HTTP client is the Rust host's (the webview has no network and
    holds no credential, ADR-0008, ADR-0014), and that client is blocking, with a 120-second limit per request and
    whole-body reads. Streaming through it needs a new host command, a thread per stream and a new event to the
    webview; that is follow-up work. The `Servers` port's `events` member is optional, so the shared code already
    falls back.

### Deferred

14. **No CRDT now.** Live co-editing (Yjs or another CRDT, shared cursors) is not part of this decision.
    `realtime-collab` stays reserved with no routes, as in ADR-0004 and ADR-0005 rule 5.

## Consequences

- Positive: no change made by someone else goes unseen; people with unsaved edits stop before typing more on a stale
  version; people see who else is on a page before they start.
- Positive: presence is plain HTTP and Postgres, so it works on every deployment, including the serverless demo.
- Positive: where SSE is available, changes appear about as soon as they are written, and polling stops for that
  workspace.
- Negative: each open page sends a heartbeat every 15 seconds (four requests a minute, one small upsert each); the
  trial's per-account limit (300 a minute) leaves ample room.
- Negative: a conflict can now open while the person is typing. That is intended (rule 2), but it interrupts.
- Negative: the desktop app still learns of changes up to 5 seconds late.
- Follow-up: streaming on the desktop host (rule 13); a revision-history view, so the notice can link to the previous
  version; CRDT co-editing as its own ADR.

## Alternatives considered

- **Presence in memory or in a pub/sub service.** Not chosen: the demo is stateless (several function instances), and
  self-hosters would need new infrastructure. Postgres is already there.
- **Presence over SSE only.** Not chosen: the demo has no SSE, and a heartbeat answer already carries the list.
- **`EventSource` on the web.** Not chosen: it cannot send an `Authorization` header, and a token in the query string
  would reach logs.
- **Automatic merge of non-overlapping edits.** Not chosen now: ADR-0005 rejects silent merging in the MVP; a CRDT
  project would replace it.
- **Live co-editing now (Yjs).** Deferred by the owner to a later project.

## Spec references

Section 8 (conditional writes, change feed, events), section 13 (real-time collaboration out of MVP scope).

## Open questions

- A link from the notice to the previous version, once the apps have a revision-history view.
- Streaming change hints through the desktop host (rule 13).
- Whether presence should also say "is editing" (typing recently) rather than "has it open".
