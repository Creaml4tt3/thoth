# ADR-0045: Switching from Obsidian, on Thoth's own terms

- **Status:** Accepted (owner, 2026-11-02): the direction, the brand rules and the order. Each step gets its own ADR
  or PR when it is built. "AI edits you review first" amended by ADR-0052 (2026-11-07): agents' memories in the
  memory folder are written without review.
- **Date:** 2026-11-02
- **Deciders:** owner

## Context

A user compared Thoth 0.2.8 with Obsidian for their own work and kept Obsidian. Their reasons:

- Claude reaches their vault through an Obsidian MCP server that reads, searches **and writes**, and their own skills
  (`/save`, `/catchup`, a vault helper) are built on it. Thoth's MCP server only reads (ADR-0021).
- Plugins (Full Calendar, Local REST API).
- Wikilinks, backlinks and the graph. Thoth has wikilinks and backlinks; it has no graph.
- A mobile app.
- Maturity.
- One real risk: Thoth keeps its SQLite index, in WAL mode, inside the vault (`.thoth/index.sqlite`). Their vault is
  on an SMB share synced by Synology Drive. SQLite over a network file system can corrupt the database, and the sync
  copies an 11 MB file that changes all the time to every machine.

The owner wants people to be able to leave Obsidian for Thoth, **without Thoth becoming a copy of Obsidian**.

## Decision

1. **The goal.** Someone can move their notes and their daily habits from Obsidian to Thoth without losing anything,
   and gains what Thoth does that Obsidian does not. Thoth does not try to look or work like Obsidian.
2. **What Thoth is, and every step must keep:**
   - Notes are Markdown files you own, readable without Thoth.
   - Sharing when you choose, on a server anyone can host, over an open protocol.
   - No silent overwrites.
   - AI edits you review first.
   - English and Thai.
3. **Brand rules:**
   - Thoth's own words in the product: Private Space, Workspace, Agent Hub, Connected apps, and for the new features
     Connections, Today and Timeline. Not "vault", "graph", "plugins" or "community plugins".
   - Obsidian is named only where it helps someone move: the importer, "Open a folder you already use", and
     comparison or "Switching from Obsidian" pages on the website. Never elsewhere in the app.
   - The website says "Switching from Obsidian", never "an Obsidian replacement" or "an Obsidian alternative".
   - Pictures and video stay in Thoth's style (the origami ibis series, dark stone, cream and orange), not a purple
     node graph.
4. **The steps, in order:**
   1. **The index leaves the notes folder.** The search index lives in the app's data folder on this computer, so
      nothing Thoth keeps for long sits beside the notes. A notice when a Private Space is on a network drive. Fixes
      the risk above.
   2. **Duplicate** for pages and folders, with "Duplicate structure only" (for templates) and "Duplicate to…".
      Owner's choices: in the Private Space, image files are copied with the pages; copying a folder out of a
      team-limited folder warns that the copy is visible to everyone, and does not copy the limit.
   3. **Connected apps can write, with review.** MCP tools under Thoth's own names (not the Obsidian MCP's) to create
      and change pages. Every change is a proposal reviewed in Thoth, as an agent run's are (ADR-0007), with a way to
      approve a batch at once. There is no "apply without asking" mode. A guide shows how to port skills such as
      `/save` and `/catchup`.
   4. **Daily habits, Thoth's way:**
      - **Connections**, a panel for one page: its links, its backlinks, and pages that mention it without a link, with
        one click to add the link. Not a whole-vault graph.
      - **Today** on Home: today's page, made from a template (built on "Duplicate structure only").
      - **Timeline**: pages by date, in the Private Space and in workspaces, with tags to filter.
      - **Open a folder you already use**, in place: Thoth reads Obsidian's `[[wikilinks]]` and `![[embeds]]` and
        never writes Obsidian's `.obsidian` folder.
   5. **Phones:** the web app made usable on a phone for workspaces first. A native app for the Private Space is a
      separate, later decision.
5. **Not planned: a plugin system.** Thoth is extended through AI agents and their skills (Agent Hub), the MCP server,
   and the open REST protocol. A plugin store is Obsidian's way, not Thoth's. Reconsider only if users ask for
   something none of those can do.
6. **What Thoth leads with** when people compare: free self-hosted workspaces with teams and folder visibility, no
   silent overwrites, AI changes shown as a diff before anything is written, Thai first, and import from both Notion
   and Obsidian.

## Consequences

- Positive: the one data risk in the review goes first, and it helps every user with a synced or network folder.
- Positive: people moving from Obsidian keep their files, links and AI habits; Thoth keeps its own character.
- Negative: no graph view and no plugins. Some Obsidian users will miss them and stay; that is accepted.
- Negative: skills built on the Obsidian MCP need porting, because Thoth does not copy its tool names.
- Negative: every AI write needs a review in Thoth, which is slower than writing directly.

## Alternatives considered

- **Copy Obsidian's MCP tool names** so skills work unchanged. Rejected: it ties Thoth's interface to another product's
  and invites "it's a clone". A porting guide instead.
- **An "apply directly" mode for trusted apps.** Rejected: it breaks "AI edits you review first".
- **A whole-vault graph.** Rejected for now: Obsidian's best-known picture, and less useful day to day than a per-page
  view.
- **A plugin API.** Rejected (rule 5).

## Open questions

- Should Connections later offer a small picture of a page's neighbourhood, drawn in Thoth's style?
- Phones: is a phone web app enough for the Private Space too, or does it need a native app?
