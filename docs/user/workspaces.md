# Workspaces

<!-- repo-only:start -->
> The website publishes this page at `/docs/workspaces/` and its Thai version (`workspaces.th.md`) at `/th/docs/workspaces/`.
> The site leaves out this block (between the `repo-only` markers) and every HTML comment. The `#` heading is the
> page's title; each `##` heading becomes an entry in "On this page", so both versions keep the same `##` headings in
> the same order.
>
> Write only what a released version does, with the app's exact labels (`packages/app-ui/src/strings/`,
> `apps/desktop/src/strings/`). If a label or a feature changes, update this page and its Thai version together.
>
> Links: `https:` and `mailto:` links, and paths on the website such as `/privacy/` or `/docs/workspaces/`.
<!-- repo-only:end -->

A workspace holds pages you share with other people on a Thoth server.

You can use the demo server, or run your own with its own sign-in: [Self-hosting](/docs/self-hosting/) explains the
setup step by step.

## Sign in

Open Settings → Servers. Choose **Add Thoth demo server**, or enter a server's
address and choose **Add server**. Then choose **Sign in with** and your provider,
and finish signing in in your browser. You can also sign in with a personal access
token. Thoth keeps your sign-in in the system keychain.

The demo server is free, with limits. Accounts unused for 90 days are deleted, and
the demo may be reset, so keep anything important in your Private Space.

Workspaces appear in the sidebar. To make one, choose **New workspace…**. You
become its owner.

## Members and invites

Each member has a role:

- **Owner**: everything a manager does, plus making owners and renaming or deleting the workspace.
- **Manager**: manages members, invite links, teams and the Trash, and sees every page.
- **Editor**: reads and edits pages.
- **Viewer**: reads pages.

Open a workspace's menu and choose **Members…**. Owners and managers can change roles, remove members and choose
**Invite people**. Only an owner can make someone an owner, or change or remove an owner. Pick the role, how long the
link works and how many people can join with it, then **Create invite link**. Copy it at once: the link is shown only
once.

To join, open the link in your browser, or paste it under **Join with an invite
link** in Settings → Servers.

To leave, choose **Leave workspace** in the members dialog.

## Teams

Owners and managers can group members into teams under **Teams** in **Members…** (**Create team**). Then right-click a
folder or page, choose **Visible to…** and **Only these teams**. Pages inside a limited folder are limited too.
Members in none of those teams cannot see those pages, search them or open their share links. Owners and managers see
every page.

## Working together

A workspace page shows who else has it open, for example "Ana is also here", when the server supports it. When someone
changes a page you have open, the page says so ("Updated by Grace just now.") instead of reloading silently. If you
have unsaved edits at that moment, Thoth asks which version to keep. A save never overwrites someone else's change.

## Share a page publicly

Owners and editors can right-click a workspace page and choose **Share…**. Anyone
with the link can read the page and the pages inside it, without signing in. They
cannot edit or comment. Choose when the link stops working, then **Create link**.
**Revoke** turns a link off at once.

## Export restrictions

When you create a workspace, you can tick **Do not allow copying or moving pages
out of it**. This cannot be changed later. In such a workspace, members cannot copy
or move pages to their Private Space or to another workspace, download them as
Markdown, or give them to the assistant.

## The workspace Trash

Deleted workspace pages and folders go to the workspace's Trash (**Trash…** in the workspace menu) and stay there 30
days. Owners and managers can **Restore** anything, or **Delete for good…**. Editors can restore what they deleted.

## Deleting a workspace

An owner can delete a workspace from its menu. For 30 days an owner can restore it,
with its pages and members, from **Recently deleted…**.

## Moving pages between spaces

You can copy or move pages between your Private Space and a workspace, or between
two workspaces, on one server or two.

- From your Private Space: right-click a page and choose **Copy to workspace…** or
  **Move to workspace…**.
- From a workspace page: use **Copy to Private Space…** or **Move to Private
  Space…** in the page header, or **Copy to another workspace…** and **Move to
  another workspace…** in its right-click menu.
- Or drag pages onto the other space in the sidebar. Dragging moves; hold
  Alt/Option to copy.

The dialog shows what will travel before anything is sent. Sub-pages, attachments
and links between the pages go with them. A move deletes the originals only after
the other side has every page. A page edited in the meantime is kept.
