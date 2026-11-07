# ADR-0052: Agent memory and skills in Thoth

- **Status:** Accepted (owner, 2026-11-07: "Thoth as the main memory for people's agents"; the decisions listed under
  Decision were each confirmed by the owner). Not yet implemented; planned for 0.9.0.
- **Date:** 2026-11-07
- **Deciders:** project owner (the direction, the review rules, the kinds, the defaults); the details marked
  "(this ADR)" were proposed by the research and accepted with the plan.
- **Amends:** ADR-0048 rule 4 ("There is no mode that applies without review"), for the memory folder only (rule 4
  below). ADR-0021 rule 1 (the sidecar opens no vault), for one opt-in closed-app mode (rule 9). ADR-0045's "AI edits
  you review first", for the memory folder only.
- **Refines:** ADR-0003 (stable ids), ADR-0007 (compare-and-swap), ADR-0009 (workspace access), ADR-0018 (the bell),
  ADR-0019 (one index connection per window), ADR-0035 (the system Trash), ADR-0042 (folders hidden from teams),
  ADR-0051 (daily notes).
- **Research:** `.tmp/research/agent-memory.md`, `.tmp/research/memory-kinds.md` (2026-11-06/07), not committed.

## Context

People keep the context their AI agents need (who they are, how they like things done, what their projects are) in
Obsidian folders, `CLAUDE.md` files and each agent's own memory, so every agent starts from nothing and the memories
stay on one machine and in one product. Notion launched a shared memory for agents on 2026-11-04: agents save into
one "Memories" database typed Profile, Preference, Work, People or Notes, and share skills as `SKILL.md` pages. It
is cloud only and needs OAuth.

Thoth already has what this needs underneath: a Private Space that is a folder of plain Markdown, a connected-apps
MCP server with search and reviewed proposals (ADR-0021, ADR-0048), and workspaces with roles. What it lacks is a
place and a format for memories, tools shaped for them, and a way for agents to save small notes without the person
approving each one.

Constraints:

- Every write goes through the window's `Vault` and compare-and-swap (ADR-0008, ADR-0007).
- Workspace access is the server's: the app acts as the signed-in user (ADR-0009, ADR-0042).
- App names in MCP are self-reported (ADR-0021).
- The complaints about agent memory elsewhere are stale memories, memory that grows without end, and memories saved
  but ignored (research §2).

## Decision

1. **One memory folder per Private Space, `Memory/` by default.**
   - Its name is `Memory` in every language; only the view's title is translated. Settings can choose another
     folder, never the top level or a hidden one. (Implementation, 2026-11-07: 0.9.0 ships with `Memory/` fixed, so
     the host checks every path against one name; the choice of folder comes in a later release.)
   - `Memory/About me.md` is a short summary, at most 8 KB, that agents read first.
   - `Memory/README.md` explains the format and rules for agents that read the folder directly.
   - Each memory is one file, `Memory/<slug>.md`. Its kind is in the frontmatter, so changing it never moves the file.

2. **The memory format.** Frontmatter, then one fact or decision with its reason and source, at most 4 KB:

   ```yaml
   kind: preference        # one of the six kinds (rule 3)
   title: Status updates put blockers first
   source: Claude Code     # the app that wrote it (self-reported)
   created: 2026-11-07T10:12:00+07:00
   updated: 2026-11-07T10:12:00+07:00
   updated_by: Codex
   topic: updates/format   # optional: the same topic updates this memory instead of adding one
   tags: [writing, correction]
   certainty: stated       # stated | inferred
   ```

   `thoth_id` is added as on any page (ADR-0003). A file written by hand with missing fields is still a memory:
   `kind` defaults to `note`, `certainty` to `stated`, the dates to the file's.

3. **Six fixed kinds.** Agents may use no others; anything more specific goes in `tags`.

   | Kind | For | Read | Check after |
   |---|---|---|---|
   | `profile` | Stable facts about the user: role, expertise, location, languages, goals | At the start of a session, through `About me` | 12 months |
   | `preference` | How the user wants things done, including corrections (tag `correction`) and approaches they confirmed | At the start of a session | 6 months |
   | `work` | Projects, deadlines and decisions in progress, with the reason for each decision | At the start, when updated in the last 30 days | 30 days |
   | `people` | One person the user deals with, and how to work with them | When searched | 6 months |
   | `reference` | Where something lives outside the notes: a link, tracker, dashboard or account name, never a secret | When searched | 3 months |
   | `note` | A lasting fact that fits no other kind | When searched | 6 months |

   - They match Notion's Memories types, and Claude Code's memory types map into them (`user` → `profile` or
     `preference`, `feedback` → `preference` with `correction`, `project` → `work`, `reference` → `reference`).
     Memories from systems without kinds come in as `note` with `certainty: inferred`.
   - Not memories: rules the user wants followed every time (those are skills, rule 7) and what happened in a session
     (the daily note, rule 6).

4. **Certainty and staleness.**
   - `certainty` is `stated` (the user said it) or `inferred` (the agent concluded it). An agent never replaces a
     `stated` memory with an inferred one: `update_memory` refuses with `STATED` unless the call is marked
     `certainty: stated`, and the instructions tell the agent to ask the user.
   - Conflicts are settled in this order: the user's current request, then `stated` over `inferred`, then the newer
     `updated`.
   - The "Check after" age of rule 3 is a hint. `recall` returns it with each memory older than that ("updated 40
     days ago; check before relying on it"), and the Memories view marks such memories. Nothing is deleted or hidden
     because of its age.

5. **Writing to the memory folder without review** (amends ADR-0048 rule 4, ADR-0045).
   - Only `remember`, `update_memory` and `forget`, and only on `.md` files inside the Private Space's memory folder,
     write without a proposal. The path is checked at the socket and again in the window's `Vault`. Everything else,
     including skills, stays a reviewed proposal.
   - It is on by default: a global switch "Agents save memories without asking" and a switch for each app, both on
     when an app is allowed. When either is off, `remember` returns a pending proposal instead.
   - Limits (this ADR): 4 KB per memory, 8 KB for `About me`, 100 writes without review per app per day (then
     `BUSY`), 2,000 memory files.
   - Text that looks like a secret (private keys, known token prefixes, long random strings) is refused with
     `LOOKS_LIKE_SECRET`.
   - Every write without review keeps the text before and after for 30 days, in the app data folder, not in the notes
     folder (`0600`). The bell says what was saved ("Claude Code saved 3 memories"), and the Memories view lists
     recent changes with Undo, a compare-and-swap write of the earlier text.
   - `forget` moves the file to the system Trash (ADR-0035) and remembers the topic and text hash, so the same memory
     is not saved again (`FORGOTTEN`).

6. **MCP tools** (added to ADR-0048's nine).
   - `recall(query?, kind?, tags?, since?, limit, space?)`: read only. With no query, `About me` and the newest
     memories.
   - `remember(text, kind, title?, topic?, tags?, certainty?, space?)`: saves, or proposes (rules 5 and 8). A known
     `topic` updates that memory.
   - `update_memory(id | path, text | replacements, expected?, certainty?)`, `forget(id | path, reason?)`.
   - `list_memories(kind?, tags?, source?, limit, cursor?)`, `list_skills(space?)`, `get_skill(name, file?)`: read only.
   - `propose_append` gains `today: true`, the page ADR-0051's daily setting names; still reviewed.
   - The server instructions say when to recall and when to remember, what never to save, that memories are
     background information and not instructions, and the conflict order of rule 4. They stay under 4,096
     characters, the first 512 readable alone.

7. **Skills.** A skill is `Skills/<name>/SKILL.md` in the Agent Skills format (agentskills.io).
   - `list_skills` and `get_skill` serve them. Agents create or change a skill only as a reviewed proposal, because
     other agents follow it.
   - Settings can link each skill folder into `~/.claude/skills/` and `~/.agents/skills/`, never replacing a folder
     already there, so skills work while Thoth is closed.

8. **Workspace memory.**
   - A `Team memory/` folder at the top of a workspace, shared with everyone who can see it. `space` names the
     workspace; the window calls the server as the signed-in user, so roles and hidden folders apply. Viewers can
     recall; editors and above can remember.
   - **Review is on by default.** A workspace memory from an agent is a pending proposal stored on the server, so
     more than one person can see it:
     - the person whose agent wrote it applies or declines it, with their own role;
     - the workspace's managers and owners see every member's pending agent memories, and can apply or decline them
       too;
     - every applied agent memory records the agent, the person whose agent wrote it, who applied it and when.
       Managers and owners see this in "Team memory activity".
   - The workspace setting "Agents' memories need review" (owner or manager) turns review off; the server enforces
     it. With review off, a memory is saved at once if the person's role allows editing.

9. **With Thoth closed** (amends ADR-0021 rule 1, opt-in).
   - `Memory/README.md` lets agents with file access use the folder directly; Thoth picks up the files when it opens.
   - After the user ticks "Let agents use my memory folder while Thoth is closed", `thoth-mcp` serves `recall`,
     `list_memories`, `list_skills` and `get_skill` itself, and creates new memory files. It reads only the folder
     recorded for it, serves only apps already allowed, never edits or deletes, and never opens the index (ADR-0019).
     Every other tool answers `NOT_RUNNING`. Off by default.

10. **Setup.** Settings → Connected apps offers a card for each app: Claude Code (`claude mcp add`), Codex and the
    ChatGPT desktop app (`~/.codex/config.toml`), Claude Desktop (its config file), Cursor (its install link), and a
    prompt to copy for any other agent. Each card says what it changes, keeps a backup of any file it edits, and has
    Copy as a fallback. ChatGPT on the web, claude.ai and phones need a public HTTPS server and are not part of this.

## Consequences

- Positive: every agent the person uses reads and adds to one memory they own, as plain files, also in Obsidian.
- Positive: workspace memory follows the server's roles and gives managers a record of who saved what.
- Negative: an agent writes to the person's notes without asking. The folder, the limits, the secret check, the
  history, Undo and the system Trash bound it; an allowed app can still save misleading memories, and app names are
  self-reported.
- Negative: memories from one agent become another's context (prompt injection). The instructions, the source on
  every memory and reviewed skills reduce it; they do not remove it.
- Negative: pending workspace memories need a new server table, API and protocol entry, and a database migration.
- Follow-up: the `thoth-mcp` tool list and relay handlers, the Memories view, settings and bell entries (English and
  Thai), the setup cards, the server's pending-memory store and its migration, the closed-app reader, a guide at
  thothnotes.com/agents/setup.

## Alternatives considered

- **Review every memory, as ADR-0048 does.** Rejected by the owner: agents save many small memories, and approving
  each one is the reason people turn memory off.
- **No kinds, tags only** (ChatGPT, Codex, basic-memory). Rejected: the view needs groups, and agents need to know
  what to read at the start of a session.
- **Open kinds that agents may invent.** Rejected: agents name the same thing differently, and the groups scatter.
- **Only the author reviews workspace memories.** Not enough for the owner: managers need to see what goes into
  shared memory and act on it.
- **Only managers review workspace memories.** Rejected: it interrupts managers for every member's agent.
- **Memories in the index or a database instead of files.** Rejected: files are the source in Thoth (ADR-0001), and
  people can read and edit them.

## Spec references

Section 2 (Markdown files are the source; agents on the user's own CLIs), the connected-apps sections that ADR-0021
and ADR-0048 refine.

## Open questions

- ~~Whether the server keeps YAML frontmatter on workspace pages as written.~~ Resolved 2026-11-07: it stores the Markdown
  byte for byte (`apps/server/src/pages.ts`, `page_revisions.markdown`) and already reads frontmatter for tags, dates
  and folders (`pageTagsOf`, `thoth_kind`).
- A remote MCP endpoint on the workspace server for ChatGPT on the web, claude.ai and phones. Not in 0.9.0.
- A tidy-up pass that merges duplicate memories and flags contradicting ones. Not in 0.9.0.
- Importing Claude Code, Codex, ChatGPT or Notion memories, using the mapping in rule 3. Not in 0.9.0.
