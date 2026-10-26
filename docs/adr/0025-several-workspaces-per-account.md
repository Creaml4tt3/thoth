# ADR-0025: Several workspaces per account

- **Status:** Accepted
- **Date:** 2026-10-26 (owner request and approval); written 2026-10-26
- **Deciders:** owner
- **Amends:** ADR-0014 rule 3 (the trial's "Workspaces per account" limit).

## Context

Until now a workspace was made only by signing up (the account's first workspace, `createWorkspaceIn` called by the
sign-in broker) and by the admin CLI `create-workspace`. There was no API route and no UI to create, rename or delete
one. The quota `MAX_WORKSPACES_PER_ACCOUNT` existed (trial value 1); `assertCanOwnAnotherWorkspace` counted the
account's `owner` memberships and serialized each account's creations with an advisory lock.

The owner asked on 2026-10-26: "Users can create multiple workspaces. On the trial server limit it to 3–5." The
orchestrator proposed 3 and including delete; the owner did not object.

## Decision

1. **Capability `workspace-management`** (ADR-0004), on by default; `WORKSPACE_MANAGEMENT=off` switches it off. Routes:
   - `createWorkspace` `POST /workspaces`: any signed-in account; the caller becomes the only member, as owner. Name
     1 to 200 characters after trimming, no control characters; `exportRestricted` (ADR-0009, default false, fixed
     afterwards). `Idempotency-Key` is honoured, like the other creating routes: a retry returns the first workspace.
   - `renameWorkspace` `PUT /workspaces/{id}/name`: owners only.
   - `deleteWorkspace` `DELETE /workspaces/{id}`: owners only.
   - `listDeletedWorkspaces` `GET /deleted-workspaces`: the caller's restorable deleted workspaces where they are an
     owner, newest first, with `deletedAt`, `deletedBy` and `restorableUntil`.
   - `restoreWorkspace` `POST /deleted-workspaces/{id}/restore` and `purgeWorkspace` `DELETE /deleted-workspaces/{id}`:
     owners of the deleted workspace (403 for its other members, 404 for anyone else, for a live workspace and for one
     past its days).
   - Other members get 403 for the owners' calls; non-members 404.
2. **Limit.** `MAX_WORKSPACES_PER_ACCOUNT` counts owned workspaces only; a membership by invite does not count. Over
   it: 409 `quota_exceeded`, `quota: workspacesPerAccount`, with `limit` and `current`. The trial profile value is
   **3** (was 1). Two creates at the limit: exactly one wins (the per-account advisory lock).
3. **Delete.** A deleted workspace is its row with `deleted_at` set. From that moment:
   - every route of the workspace is 404 for every member, and it is not listed;
   - share links and invite links stop at once: the lookups leave deleted workspaces out, and its active links are
     also revoked in the same transaction, so a restore does **not** bring them back (restoring must not republish
     pages without an owner deciding again);
   - memberships stay, so a restore brings back the members with their roles.
4. **Restore within 30 days** (`DELETED_WORKSPACE_RESTORE_DAYS`) by an owner of the workspace. After that it cannot be
   restored and the daily maintenance purges it: pages, revisions, attachments (and their bytes when nothing else
   uses them), changes, transfers, share and invite links, memberships, the row. The audit trail stays (it names the
   workspace by ID, never content). An owner may also purge it earlier ("Delete permanently").
5. **A deleted workspace keeps counting toward its owners' limit until it is purged** (or its 30 days are over, even
   before maintenance runs). Why: the server keeps a deleted workspace's data for 30 days, so if deleting freed the
   place at once, an account could create and delete over and over and hold up to 30 days' worth of workspaces on the
   1 GB trial database. Counting bounds what one account can hold to the limit at any time. "Delete permanently" is
   the way to free the place now, and it removes the data at once, so it does not open the same hole.
6. **Churn guard.** At most `MAX_WORKSPACE_CREATIONS_PER_DAY` creations per account per UTC day through the API (trial
   10, default unlimited): 409 `quota_exceeded`, `quota: workspaceCreationsPerDay`, with `Retry-After`. A refused create
   spends none (the counter is in the same transaction). It limits create/purge cycles, which cost writes and blob
   churn even though they hold no data. Sign-up's first workspace and the CLI do not count.
7. **Storage of blobs.** Blobs are content-addressed and shared. After a purge commits, the bytes of each of its
   hashes that no attachment row names are removed, under an exclusive advisory lock (`blob-gc`) that every upload
   holds shared from before it stores bytes until its row commits. So an upload of the same bytes either committed
   first (the blob is kept) or writes the bytes again afterwards.
8. **Apps (desktop and web).**
   - "New workspace on …" in a server's sidebar section header (desktop) or the sidebar header (web), and "New
     workspace…" in the palette. The dialog shows "You own n of N workspaces this server allows" when the server has a
     limit, counting deleted ones; at the limit Create is off and it says where to make room. One `Idempotency-Key`
     per dialog. The new workspace opens in the sidebar and takes focus.
   - Rename… (also F2 on the row) and Delete… for owners in the workspace row's menu next to Members…, and in the
     palette. Delete asks for the workspace's name.
   - Under a server's workspaces: "2 of 3 workspaces" once near the limit, and "Recently deleted (n)", which opens the
     list with Restore and "Delete permanently…" (again after typing the name).
   - English and Thai. Announcements go to a live region of the server section, which outlives the deleted row.
9. **Migration `012_workspace_deletion.sql`**, additive only: `workspaces.deleted_at`, `workspaces.deleted_by` and a
   partial index. Safe on the live database while the previous build runs.

## Consequences

**Positive**

- People make, rename and remove workspaces themselves, on the trial too, within a limit the operator sets.
- A mistaken delete can be undone for 30 days, by any owner.
- The trial database holds at most `limit` workspaces' worth of data per account at any time.

**Negative**

- Someone who deletes a workspace on the trial and wants a new one at once must delete it permanently first. The
  dialog says so.
- A co-owner's deletion also counts against the other owners' limits until it is purged; any of them can restore or
  purge it.
- An open event stream of a deleted workspace ends at its next 30-second re-check, not at once (the trial has none).
- Idempotency records of the last 24 hours may still hold replies of a purged workspace's writes for the principal who
  made them; they expire within the window.
- A desktop transfer in flight against a deleted workspace fails with 404; after a purge its record is gone.

**Follow-up work**

- An "undo" toast right after Delete.
- Leaving or transferring ownership before deleting, for teams.
- Changing the export restriction after creation.

## Alternatives considered

- **Deleted workspaces stop counting at once, plus a deletions-per-day cap.** Not chosen: with 30 days of retention
  the cap would still let one account hold `cap × 30` workspaces of data.
- **Hard delete without restore.** Not chosen: the owner accepted a 30-day restore, and a mistaken delete of a shared
  workspace is costly.
- **Restore brings back the old share and invite links.** Not chosen: the links would start working again for anyone
  holding them, without an owner deciding so.
- **`PATCH /workspaces/{id}`.** The registry has no PATCH; `PUT …/name` follows `PUT …/members/{userId}`.

## Spec references

- ADR-0004 capabilities; ADR-0009 roles, export restriction, audit; ADR-0013 and ADR-0014 trial limits; ADR-0023 share
  links; ADR-0024 members and invite links.
- docs/protocol/README.md sections 3, 5, 8 and 10.

## Open questions

1. Whether the trial should move to 5 workspaces after real usage (the owner said 3–5).
2. Whether "Delete permanently" should need the account to sign in again.
