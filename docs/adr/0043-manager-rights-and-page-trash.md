# ADR-0043: What managers may do, and a Trash for pages

- **Status:** Proposed
- **Date:** 2026-11-01
- **Deciders:** owner (rules 1 to 4, agreed from the proposal compared with Slack, Notion and Google shared drives);
  rules 5 to 9 are how they are built
- **Amends:** ADR-0042 (rule 1: who invites and runs members; rule 3: who sees limited pages)

## Context

ADR-0042 added the role `manager` with the permission `manage`: teams and page visibility. Everything about members
and invite links stayed with owners (`administer`), and a manager in none of a folder's teams could not see that
folder. Deleting a page set `pages.deleted_at` and kept the page and its revisions with no way to bring it back; only
whole workspaces had "Recently deleted" (ADR-0025).

The owner asked who should be able to restore deleted pages, and whether managers should invite people. Slack (Owner
and Admin), Notion (Owner and Membership Admin) and Google shared drives (Manager and Content manager) share one split:
admins run people and content day to day, and owners alone keep what cannot be undone or affects the whole
workspace.

## Decision

1. **Managers see every page**, like owners, also pages limited to teams they are not in. `thoth_hidden_pages`
   (migration 016) exempts owners and managers. Becoming or ceasing to be an owner or a manager changes what a member
   sees, so it expires older change cursors (ADR-0042 rule 6).
2. **Managers run members who are not owners.** `manage` now also covers: creating, listing and revoking invite links
   (any role a link can give: manager, editor, viewer); changing a member's role among manager, editor and viewer;
   removing a member who is not an owner. An invite link works while its creator is still an owner or a manager.
3. **Owners keep** (`administer`): making someone an owner, changing an owner's role, removing an owner, renaming the
   workspace and deleting, restoring or purging it. A manager trying any of these gets 403. The export setting is chosen
   when an owner creates the workspace and has no route to change it.
4. **A Trash for pages.** A deleted page or folder stays in its workspace's Trash for 30 days
   (`TRASH_RESTORE_DAYS`), then it is removed for good. Owners and managers see the whole Trash, restore anything and
   delete anything for good. Editors see and restore only what they deleted themselves. Viewers have no Trash.
5. **Items.** An item of the Trash is a deleted page whose folder is live, absent or gone for good. Pages deleted below
   it, through deleted pages only, belong to that item and come back with it. `pages.updated_by` names who deleted a
   page: `deletePage` sets it, and a deleted page is not written again until it is restored. Restoring an item brings
   back the page, where it was (at the top level when its folder is gone for good), and every page below it that the
   caller may restore; for an editor, a page someone else deleted stays in the Trash, as its own item. Each restored
   page is `page.created` in the change feed, parents first, and counts toward `maxPagesPerWorkspace`.
6. **Deleting for good** removes the item and the pages deleted below it with their revisions, their change-feed
   entries (which hold titles) and their share links. The feed then has holes; a read with nothing left up to the head
   moves the cursor to the head. A live page below a deleted folder (one added while a client was deleting the folder
   page by page) moves to where the item was, and takes the limits of the removed folders between them: it keeps only
   the teams that were in every one of those limits, so it is never seen by more people.
7. **The purge.** The daily maintenance removes every item older than 30 days (`trashPagesPurged` in its result), one
   workspace per transaction under the workspace row lock, so a restore that wins the race keeps its pages. Pages
   deleted before migration 016 get the full 30 days from the migration, rather than being removed by the first run.
8. **Deleting a team** asks first in the clients and lists the folders limited to it, through the new route
   `listTeamPages` (owners and managers): those only this team saw are seen by owners and managers alone afterwards.
   Deleting a team never shows a page to more people (ADR-0042 rule 3).
9. **Protocol.** A new capability `trash` with the routes `listTrash`, `restoreTrashedPage` and `purgeTrashedPage`
   (schemas `TrashItem`, `TrashList`, `TrashRestored`), and `listTeamPages` under `teams` (schemas `TeamPage`,
   `TeamPageList`). The clients show "Trash…" in a workspace's menu to editors and up only when the server lists
   `trash`, and say in the delete dialog that the page stays in the Trash for 30 days.

## Consequences

- Positive: someone who deletes by mistake gets it back without asking an owner, for 30 days.
- Positive: managers can run a workspace day to day, invite people and fix limits on folders they are not in.
- Positive: deleted pages no longer pile up on the server for ever.
- Negative: a manager can see every page; a folder meant for a few people is seen by every manager too.
- Negative: pages deleted before this change are removed 30 days after the upgrade.
- Negative: deleting for good leaves holes in change-feed positions (handled by the feed read, rule 6).
- Negative: a `from_workspace` transfer still running when its page is deleted for good fails on that page.

## Alternatives considered

- **Everyone who could see a page restores it (Notion).** Simpler, but lets an editor undo another member's delete;
  the owner preferred editors restoring only their own.
- **Opening the folders of a deleted team to everyone.** Rejected: it could show private pages to people never meant to
  see them.
- **Keeping invite links with owners.** Rejected by the owner: managers run members day to day.
- **Refusing to delete for good a folder with a live page below it.** Leaves a page the person cannot find in the
  Trash; moving it out (rule 6) keeps it and its limits.

## Spec references

Section 3.2 (authorization on the server), 8, 9.1, 11 (authorization, audit events), 12.

## Open questions

- Attachments of pages deleted for good stay until the workspace is purged; ADR-0042's open question on attachments
  covers tying them to pages.
