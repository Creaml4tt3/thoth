# ADR-0048: Connected apps propose changes, reviewed in Thoth

- **Status:** Accepted (owner, 2026-11-02: ADR-0045 step 3, "Connected apps can write, with review")
- **Date:** 2026-11-02
- **Deciders:** project owner (the direction and the requirements); the details marked "(this ADR)" were decided
  while implementing them.
- **Amends:** ADR-0021 rule 4 ("Writes are a later step"). Everything else in ADR-0021 stands.
- **Refines:** ADR-0007 (review before apply, compare-and-swap), ADR-0018 (the bell), ADR-0045 (the brand rules and
  "AI edits you review first").

## Context

ADR-0021 gave other apps (Claude Desktop, Cursor and other MCP clients) four read-only tools, and left writing for
later: "proposed changes reviewed in the app, as an agent run's are, and applied with compare-and-swap". ADR-0045 made
this step 3 of switching from Obsidian. People who keep Claude skills such as `/save` or `/catchup` need a way to
write, and Thoth's promise is that an AI's edit is shown to the person before anything is written.

Constraints:

- The vault logic, and so every write, is in the window's `Vault` over the host's ports (ADR-0008). The host cannot
  write a page itself without a second copy of that logic.
- `thoth-mcp` keeps nothing; a tool call is one line to the host and one line back (ADR-0021 rule 1).
- An agent run's review (ADR-0007) is per file with a line diff (`DiffView`), and the run's changes are applied with
  compare-and-swap on the hash read before the run.

## Decision

1. **Five more tools, under Thoth's own names** (not another product's, ADR-0045).

   | Tool | What it does | Annotations |
   |---|---|---|
   | `propose_create_page` | A new page: `path`, or `title` (and `folder`), and `markdown` | not read-only, not destructive, not idempotent, closed world |
   | `propose_edit_page` | A change to one page (`path` or `id`): `markdown` (the whole new page) or `replacements` (`[{ find, replace }]`), and optional `expected` | as above |
   | `propose_append` | `markdown` added at the end, or at the end of the section under `heading` (its text), and optional `expected` | as above |
   | `list_proposals` | The app's own proposals, newest first, optionally by `status` (1 to 100, default 20) | read-only |
   | `get_proposal` | One of the app's own proposals by `id` | read-only |

   - The four read tools stay as they are, except that `read_page` adds `version` (the page's content hash) to its
     structured result, so an app can pass it as `expected` (this ADR).
   - `list_proposals` and `get_proposal` are marked read-only: they only read what became of the app's proposals.
2. **A tool call never writes.** It reads the page through the window (`read_page`, as the read tools do; the
   proposed text is never sent to a window), computes the page as it would be, and the host keeps that as a proposal.
   It answers at once with the proposal's `id` and `status: "pending"`.
   - **Replacements** apply in order; each `find` must occur exactly once in the text as the earlier ones left it.
     None or several is `BAD_ARGUMENT`, and nothing is kept.
   - **Under a heading:** the heading's text must occur once (outside code blocks and the front matter); the text is
     added before the next heading of the same or a higher level.
   - **`expected`:** when given, it must be the page's version now, else `CONFLICT` and nothing is kept.
   - **A new page** at a path where the index has a page is `EXISTS`. A change that leaves the page as it is, is
     `BAD_ARGUMENT`.
3. **Kept by the host, in the app data folder.** `<data>/mcp/proposals/<id>.json`, one owner-only file each (`0600`
   in a `0700` folder), never in the notes folder. A file holds who proposed it, the Private Space, the path, the
   page's version it was made from, and the page before and after.
   - **Limits.**

     | Limit | Value |
     |---|---|
     | Proposals waiting (pending or conflicted), from every app | at most 100 (`BUSY`) |
     | A proposed page, or the text added | at most 1 MB (`TOO_LARGE`), as an answer (ADR-0021 rule 3) |
     | Replacements in one call | at most 100 |
     | Waiting before it expires | 7 days |
     | A settled one is remembered (without its text) | 7 days more, at most 500 |
     | Request line | 2 MiB + 64 KiB, so that a 1 MB page fits after JSON escaping (was 64 KiB) |

   - **Statuses:** `pending`, `applied`, `declined`, `expired` (7 days without review), `conflicted` (the page changed
     before it was applied; it still waits for the user). Applied, declined and expired keep no page text.
4. **Permission: the same Allow / Deny per app, and "May propose changes".** An app must be allowed to read, and its
   switch "May propose changes" must be on. The switch is off until the user turns it on. The first time an allowed
   app proposes, every window asks "Let “app” propose changes?" (focus on "Don’t allow", Escape does not answer), and
   the call waits up to 60 seconds, as the first Allow does. The answer is remembered; Settings → Connected apps shows
   the switch per app. **There is no mode that applies without review** (ADR-0045).
5. **Review in the window, from the bell.** The bell's list starts with "N proposed changes to review" while any
   wait for this window's Private Space, and the bell's count includes them. It opens the review:
   - per app ("From “app”"), each proposal with the app, when, the page, its kind and a diff (the Agent Hub's
     `DiffView`), and Apply / Decline;
   - "Apply all from <app>" applies that app's pending ones one by one, each checked on its own.
6. **Apply is compare-and-swap in the window's Vault.** `writePage(path, after, { expectedHash: baseHash })`; a new
   page is `expectedHash: null`, which never replaces a file. The window then reports `applied` (`mcp.settle`).
   - **The page changed since:** nothing is written and the proposal becomes `conflicted`. The review shows the diff
     against the page as it is now, with Decline and "Apply anyway", which writes over that version only (CAS on its
     hash), so the user sees exactly what is replaced. A new page whose path is taken can only be declined.
   - Only a window with the proposal's Private Space open may settle it (`NOT_ALLOWED` otherwise).
7. **Scope and paths: as the read tools.** Only Private Spaces the user shared and that are open in a window;
   workspaces stay out (ADR-0021 rule 3). Paths are checked at the socket (no `..`, absolute path, backslash or control
   character), must be Markdown (`.md`, `.markdown`) and may not be in a hidden folder (so never `.thoth/`). The
   window's Vault checks again when it writes.
8. **The request log** keeps the tool, the app, the Private Space, the page path and how it ended; never the
   proposed text, a `find` or a heading (ADR-0021 rule 5).
9. **Web client: nothing** (ADR-0021 rule 6). The bell's pinned entry is generic in `@thoth/app-ui`; its text, the
   review and the commands are the desktop's, and `apps/web/test/bundle.ts` checks their names stay out.

**Host commands** (desktop capability):

| Command | Purpose |
|---|---|
| `mcp.mayPropose` | "May propose changes" for an app, and the answer to the question |
| `mcp.proposals` | Every proposal remembered (no text) and how many wait |
| `mcp.proposal` | One proposal with the page before and after |
| `mcp.settle` | A window's report: applied, declined or conflicted |

The host's new event is `mcp.proposals` (`{ open }`), sent by the shell as `thoth:mcp-proposals`; `mcp.pending` now
also names the apps waiting for "May propose changes" (`proposers`).

## Security model

- Nothing new is reachable: a proposal reaches only shared, open Private Spaces, through the same socket and the same
  self-reported app name (ADR-0021). Any program of this user can already write those files; what this adds is a
  supported, logged and reviewed way.
- **Nothing is written by an app.** Every write is the user's Apply in a window, with compare-and-swap. A page that
  changed is never overwritten without the user seeing the diff against it.
- **Bounded:** 100 waiting, 1 MB each, 7 days, 2 MiB request lines; the question is asked at most for 4 apps at once.
- **The webview** (untrusted, ADR-0008) can turn the switch on and settle a proposal, as it can Allow an app. It
  already writes the Private Space it has open, so this gives it nothing new. `mcp.settle` checks that the calling
  window has the proposal's Private Space open.
- An app sees only its own proposals (by name), and not the folder on this computer (`root`) or the version.

## Consequences

- Positive: skills that save or append notes work through Thoth, and every change is shown before it is written.
- Positive: proposals live outside the notes folder; a synced notes folder never carries them.
- Negative: an app learns only later whether its change was applied (`get_proposal`); a review is slower than a
  direct write. Accepted (ADR-0045).
- Negative: "Apply anyway" after a conflict writes the proposal's whole page over the current one. Replacements and
  additions are not re-run on the newer page (Open questions).
- Negative: proposals wait while Thoth is closed; they show when a window opens their Private Space.

## Alternatives considered

- **Reuse the Agent Hub's `Review` component as it is.** It is built around one run's changes with checkboxes and one
  Apply for all of them, and its `ProposedChange` comes from a run's working copy. A proposal is per app and per call,
  with Apply and Decline each. The review reuses `DiffView` and the Agent Hub's layout classes instead (this ADR).
- **The host writes the page itself.** It would need the vault logic in Rust (ADR-0008) and would bypass the index.
- **Compute the change when the user applies it.** The app would not learn at once that its `find` did not match;
  checking at proposal time answers it while it still has the context.
- **An "apply without asking" mode for trusted apps.** Rejected by ADR-0045.

## Spec references

Section 3.3 (local access), section 4 (runtime boundary), section 12 (desktop), section 14.11 (the web client has no
local access).

## Open questions

- Re-running replacements and additions on the newer page after a conflict, instead of offering the old result.
- A native confirmation from the host for "May propose changes" (ADR-0021's open question on writes).
- Proposals for workspaces (their access is the server's, ADR-0009).
