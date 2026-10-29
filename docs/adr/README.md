# Architecture Decision Records

This directory holds the Architecture Decision Records (ADRs) for Thoth. ADR
topics follow spec section 16 of the architecture handoff (v0.2). The spec's
section 2 ("Locked decisions") is the baseline; an ADR may refine it but must not
contradict it. Changing a locked decision requires a new ADR stating the
trade-off.

## Index

| No. | Title | Status |
| --- | ----- | ------ |
| [0001](0001-markdown-private-space-source.md) | Markdown as portable Private Space source | Accepted |
| [0002](0002-canonical-content-model-and-editor-serialization.md) | Canonical content model and editor serialization | Accepted (editor part accepted 2026-10-21) |
| [0003](0003-stable-logical-identity-vs-physical-location.md) | Stable logical identity vs physical location | Accepted |
| [0004](0004-workspace-protocol-and-capability-negotiation.md) | Workspace protocol and capability negotiation | Proposed (finalize in phase P2) |
| [0005](0005-revision-based-synchronization-and-conflict-resolution.md) | Revision-based synchronization and conflict resolution | Proposed |
| [0006](0006-transfer-lifecycle-idempotency-and-recovery.md) | Transfer lifecycle, idempotency, and recovery | Proposed (implementation phase P3) |
| [0007](0007-agent-adapter-contract-and-execution-security.md) | Agent adapter contract and execution security | Accepted for the Claude Code adapter, decisions of 2026-10-25 (owner to confirm); Proposed for Codex, OS-level sandboxing, answers and sessions, and conversations (2026-10-26) |
| [0008](0008-desktop-runtime-web-client-and-local-bridge.md) | Desktop runtime, web client, and local bridge | Accepted for Tauri 2 + Rust, shared React/TS/Vite UI, and Rust-hosted ports (2026-10-21); Proposed for the local bridge |
| [0009](0009-workspace-authorization-and-sharing-semantics.md) | Workspace authorization and sharing semantics | Proposed (phase P2) |
| [0010](0010-notion-obsidian-import-format-and-compatibility-policy.md) | Notion/Obsidian import format and compatibility policy | Accepted |
| [0011](0011-license-and-contribution-policy.md) | Open-source license and contribution policy | Accepted 2026-10-22: Apache-2.0, DCO |
| [0012](0012-plain-markdown-editor-mode.md) | Plain Markdown editor mode beside the block editor | Accepted 2026-10-22 |
| [0013](0013-authentication-hosted-trial-and-website.md) | Authentication (OIDC), a hosted trial server, and the project website | Accepted 2026-10-22 (limits and hosting in ADR-0014) |
| [0014](0014-hosted-trial-deployment-and-sign-in-broker.md) | Hosted trial deployment (Vercel + Neon) and the sign-in broker | Accepted 2026-10-22 |
| [0015](0015-website-web-client-and-analytics.md) | Website, trial-only web client, and analytics (GA4) | Accepted 2026-10-24 |
| [0016](0016-editor-ux-text-styles-order-tabs-and-themes.md) | Text styles, page order, folders, tabs and themes | Accepted 2026-10-24 |
| [0017](0017-page-kind-in-the-workspace-protocol.md) | Page kind in the workspace protocol | Accepted 2026-10-25 |
| [0018](0018-notifications.md) | Notifications: in-app list, mascot, system notifications | Accepted 2026-10-25 |
| [0019](0019-tab-order-and-windows.md) | Tab order and windows | Accepted 2026-10-26; amendment (live tab preview, tab width, sidebar sections) Proposed 2026-10-26 |
| [0020](0020-links-from-pasted-urls-and-link-previews.md) | Links from pasted URLs and link previews | Accepted 2026-10-26 |
| [0021](0021-connected-apps-read-only-mcp-server.md) | Connected apps: a read-only MCP server | Accepted 2026-10-26 |
| [0022](0022-update-notice.md) | Update notice: a popup when a new desktop version is out | Accepted 2026-10-26; rule 1 superseded by 0034 |
| [0023](0023-public-read-only-share-links.md) | Public read-only share links for workspace pages | Accepted 2026-10-25; SVG pictures amendment Proposed 2026-10-28 |
| [0024](0024-workspace-members-and-invite-links.md) | Workspace members and invite links | Accepted 2026-10-26 |
| [0025](0025-several-workspaces-per-account.md) | Several workspaces per account: create, rename, delete, restore | Accepted 2026-10-26 |
| [0026](0026-blog-and-changelog-on-the-website.md) | A blog and a changelog on the website | Proposed 2026-10-26 |
| [0027](0027-favorites-and-pinned-tabs.md) | Favorites and pinned tabs | Proposed 2026-10-26 |
| [0028](0028-images-in-pages.md) | Images in pages | Proposed 2026-10-26 |
| [0029](0029-home-tab-and-recent-pages.md) | Home tab and recent pages (desktop: Home is the Private Space picker, amendment 2026-10-28; a new tab lists recent pages and favorites, 2026-10-29) | Proposed 2026-10-27, amended 2026-10-28 and 2026-10-29 |
| [0030](0030-split-view-two-panes.md) | Split view, two panes side by side | Proposed 2026-10-27 |
| [0031](0031-thothnotes-domain-and-bundle-identifier.md) | thothnotes.com, and the bundle identifier com.thothnotes.desktop | Proposed 2026-10-27 |
| [0032](0032-first-run-welcome-pages-and-tour.md) | First run: Welcome pages and a tour of the basic tools | Proposed 2026-10-27 |
| [0033](0033-feedback-from-users.md) | Feedback from users, in the apps and on the website | Proposed 2026-10-27 |
| [0034](0034-in-app-updates.md) | In-app updates: signed, downloaded when the person clicks Update | Accepted 2026-10-28 |
| [0035](0035-delete-pages-and-folders.md) | Deleting pages and folders: the system Trash, and workspace pages for everyone | Proposed 2026-10-29 |
| [0036](0036-download-a-page-as-markdown.md) | Download a page as Markdown: the host's Save as, the browser's download | Proposed 2026-10-29 |
| [0037](0037-sidebar-new-items-folder-colors-and-switcher.md) | New items from the trees' menus, the target folder, folder colors and the space switcher | Accepted 2026-10-29 |
| [0038](0038-moving-between-spaces-and-opening-links.md) | Moving pages between spaces, and opening links in a page | Proposed 2026-10-29 |

Template: [0000-template.md](0000-template.md).

## Template

Every ADR uses the same sections, in this order (see `0000-template.md`):

1. **Title** - `ADR-NNNN: <title>`.
2. **Status** - `Proposed`, `Accepted`, or `Superseded by ADR-xxx`; may be scoped
   (for example "Accepted for the desktop runtime; Proposed for the rest").
3. **Date** - ISO date of the decision or last status change.
4. **Context** - the problem and constraints.
5. **Decision** - testable rules, only decisions actually made.
6. **Consequences** - positive, negative, and follow-up work.
7. **Alternatives considered** - options not chosen, with reasons.
8. **Spec references** - sections of the handoff spec implemented.
9. **Open questions** - unresolved items and what each blocks.

## Conventions

- Number ADRs sequentially; file names are `NNNN-kebab-case-title.md`.
- Do not rewrite an accepted decision. Supersede it with a new ADR and update the
  old ADR's status line and this index.
- Keep each ADR focused on one decision area; link to other ADRs with
  `ADR-NNNN` rather than repeating them.
- Where something is undecided, record it under "Open questions" instead of
  stating it as a decision.
- Do not invent third-party CLI flags, file formats or API behavior in an ADR;
  note that they must be verified against official documentation at
  implementation time.
