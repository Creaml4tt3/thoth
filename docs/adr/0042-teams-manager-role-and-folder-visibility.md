# ADR-0042: Teams in workspaces, a Manager role, and folder visibility

- **Status:** Proposed
- **Date:** 2026-11-01
- **Deciders:** owner (rules 1 to 3, the decisions in the task); rules 4 to 9 are how they are built
- **Amended by:** ADR-0043 (managers see every page, run members who are not owners, and make invite links)

## Context

ADR-0009 gave each workspace three roles and left "page-level permissions beyond workspace roles" as an open question.
Every member of a workspace sees every page. The only gate is `workspaceAccess` (`apps/server/src/access.ts`): a
non-member gets 404, a member whose role is too low gets 403. ADR-0024 added members and invite links; ADR-0017 made
folders pages of kind `folder`; ADR-0023 added public share links that re-check their link on every view.

Teams that share one workspace want some folders seen by some people only (for example a Finance folder).

## Decision

1. **A new role, `manager`.** The roles, highest first, are `owner`, `manager`, `editor`, `viewer`. A manager has
   an editor's permissions plus a new permission, `manage`: create, rename and delete teams, add and remove team
   members, and choose which teams see a folder or page. Owners have `manage` too. `administer` (roles, members,
   invite links, the workspace itself) stays with owners. An invite link may give `manager`; only owners make invite
   links, so only owners can invite managers. `roleCan`, the server's role list, the `memberships` and `invite_links`
   role checks (migration 015) and every role picker include it.
2. **Teams.** A team is a named group of members of one workspace (1 to 100 characters, at most 100 teams). Every
   member reads the teams and who is in them. A member who leaves or is removed leaves its teams too.
3. **Visibility.** A page (in the UI: a folder, or a page, through "Visible to…") is either visible to everyone in the
   workspace (the default, also for every new folder) or limited to one or more teams. The limit applies to the page
   and everything below it, at any depth, also to pages moved under it later: moving a page into a limited folder
   limits it. A member in none of the teams cannot see it. Owners always see every page. Deleting a team never shows a
   page to more people: a page whose last team is gone is seen by owners only.
4. **A hidden page does not exist.** For a member who may not see it, a hidden page is 404 `not_found`, never 403:
   - `GET` page (also `?revision=`), `PUT` (also a create over its ID), move, delete, revisions, the visibility calls,
     and share-link create and list;
   - as the parent of a new, written, moved or transferred page;
   - absent from the tree, search (also `withinPageId`) and `from_workspace` transfers;
   - a transfer created by another member that names it is 404 to this member;
   - its change-feed entries are left out, though the cursor still moves past them.
   Event hints (SSE) carry no page data, but their timing would say that a hidden page changed: a stream sends a
   hint only when the new entries include one the member may see (a page not hidden from them, or no page).
5. **One definition.** The SQL function `thoth_hidden_pages(workspace, user)` (migration 015) returns every page
   the account may not see, with one recursive CTE: the limited pages whose teams do not include the account (none
   for an owner), and everything below them, deleted pages included. Every route above filters with it (`id NOT IN
   ...`) through `apps/server/src/visibility.ts`. A workspace without limits costs one empty index scan.
6. **Stale trees.** A client's tree and change cursor may hold pages it may no longer see, or miss pages it may now
   see. So every change to who sees what (a limit set or lifted, a team deleted or its members changed, a member made
   owner or no longer owner, a page moved under another parent while any limit exists) appends a change entry of the
   vendor kind `x-thoth.visibility` (clients ignore unknown kinds) and records its position in
   `workspaces.visibility_seq`. A change cursor before that position is answered with 410 `cursor_expired`, which every
   client already handles by reading the tree again.
7. **Public share links (decided).** A public link never serves a limited page or anything below it, whoever made
   the link: a link to such a page stops working (the same 404 as any dead link), a shared tree leaves those pages out,
   and creating a link to a limited page is refused (403 `forbidden`, since the member can see the page). A share is
   made by a member who could see the page; the limit says who may, so the public may not. Lifting the limit makes the
   link work again, like other dead links that come back (a creator restored to a writing role).
8. **Attachments are unchanged.** An attachment is not tied to a page, so it is not limited: any member who knows its
   ID can still read it. The owner decided to leave this as it is for now.
9. **Protocol.** A new capability `teams` covers the role `manager` and the routes `listTeams`, `createTeam`,
   `renameTeam`, `deleteTeam`, `addTeamMember`, `removeTeamMember`, `getPageVisibility` and `setPageVisibility`
   (schemas `Team`, `TeamList`, `TeamWrite`, `PageVisibility`, `PageVisibilityWrite`). The clients show the Teams
   section of Members… and "Visible to…" in a page's or folder's menu only when the server lists `teams`, the latter
   only to owners and managers. Older servers show neither. An older client that meets the role `manager` on a newer
   server cannot parse it; this is accepted, because only a server listing `teams` can hold such a role.

## Consequences

- Positive: one workspace serves several teams without separate workspaces; the 404 rule keeps hidden folders'
  names and existence private.
- Positive: one SQL function decides visibility; each route adds one filter, and a test per route proves no leak
  (`apps/server/test-db/teams.test.ts`).
- Negative: page reads cost one more query (an index lookup when a workspace has no limits).
- Negative: any change to who sees what makes every member's client read the whole tree again.
- Negative: attachments of limited pages stay readable by ID to all members (rule 8).
- Negative: a manager who is not in a limited folder's teams cannot see it, so cannot lift its limit; an owner can.

## Alternatives considered

- **Per-page access lists of users.** More flexible, but more to manage and to show; teams cover the request.
- **403 for hidden pages.** Simpler, but tells a member that the page exists.
- **Filtering the change feed only, without expiring cursors.** A client would keep pages it may no longer see in its
  tree until it reloaded.
- **Keeping public links to limited pages working.** Rejected (rule 7): a public link would expose what the limit
  hides from members.

## Spec references

Section 3.2 (authorization on the server), 8, 9.1, 11 (authorization, audit events), 12.

## Open questions

- Attachments of limited pages (rule 8): limit them by the pages that use them. Blocks nothing now.
- Whether managers should see every page, like owners. Decided in ADR-0043: they do.
