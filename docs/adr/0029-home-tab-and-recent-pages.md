# ADR-0029: Home tab and recent pages

- **Status:** Proposed
- **Date:** 2026-10-27
- **Deciders:** owner (the batch 2 "defaults"), orchestrator (brief), implementation agent

## Context

A Private Space used to open on its first page by path, and a new tab showed "Nothing open". The owner asked for a Home
tab with the pages opened last and the favorites, opened by the logo and a Home button. Constraints: tabs are plain data
in `packages/app-ui/src/tabs/model.ts` and are stored as ids with no titles (ADR-0016 rule 5, ADR-0019); favorites
already exist (ADR-0027); the web client keeps no sign-in data in `localStorage` (ADR-0015 rule 1); nothing about what a
person opens goes into the vault or to a server.

## Decision

1. **A tab target `{ kind: "home" }`**, stored as `{ "k": "home" }` (older versions drop an entry they cannot read, so
   the stored version stays 1). There is at most one Home tab, like Settings: opening Home goes to it when it is open,
   takes the current tab when that is a new (blank) tab, and otherwise opens a new tab after the current one. Its tab
   shows a house icon and the name "Home".
2. **A new tab is `blank` and shows the same Home view**, named "New tab", so a new tab is never empty. Clicking a page
   in it replaces it, as before.
3. **At start, with nothing to restore, a window opens Home** instead of the first page. The desktop's `AppOptions`
   has `startOnHome` (default true); the unit tests set it to false so that they still start on the first page, and the
   Home tests set it to true. The web client already starts on one new tab, which shows Home.
4. **The Home view**: the Thoth mark, a greeting (h1), then "Recent" and "Favorites" (h2), each a plain list of buttons.
   A row has the page's title, its space as a badge (Local, or the workspace's name) and its folder ("Top level" when
   none). A click or Enter opens the page in this tab; Cmd/Ctrl+click, a middle-click or Cmd/Ctrl+Enter opens it in a new
   tab. Favorites is the full list from the favorites controller, in its own scrolling list. Each list has a short hint
   when empty. The parts are headings and lists, not landmarks: the sidebar's Favorites is the region of that name.
5. **Ways to open Home**: the sidebar's brand row (the mark and "Thoth") is a button named "Thoth home" (the visible word
   stays in the name), a house button at the start of the tab bar, the palette's "Go home", and Alt/Option+Shift+H on
   both clients (by physical key; Cmd/Ctrl+Shift+H is Highlight).
6. **Recent pages** (`packages/app-ui/src/home/recent.ts`): a list in `localStorage`, never in the vault and never sent.
   The desktop keeps one per Private Space (`thoth.desktop.recent.<folder>`, shared by its windows); the web one per
   account (`thoth.web.recent.<account id>`; with no account known it lasts for the visit). Entries are
   `{ "k": "page", "path" }` or `{ "k": "ws", "server", "workspace", "page" }` with the time opened: no titles, which are
   looked up as tab labels are. Up to 20 are kept and 5 shown, newest first, each page once.
7. **Recorded** when a tab showing a page becomes current, or the current tab starts showing another page; never on an
   edit. **Kept current**: every rename or move that remaps the tabs remaps the list (the desktop's tabs controller does
   both); pages that are gone drop out by the tabs' rules (a Private Space path the index no longer has, except the
   current tab's page, whose rename may still be on its way; a workspace page or workspace the server says is gone,
   which includes a workspace the account lost).
8. Signing out of the web client keeps the list, like workspace favorites (ADR-0027): it is per account and holds ids
   only.

## Consequences

- Positive: a new or empty window has somewhere useful to start; recent work is one click away on both clients.
- Negative: the first page no longer opens by itself; older e2e tests open it themselves. The account id appears in a
  `localStorage` key name on the web (as it already does inside the workspace favorites' value).
- Follow-up: a setting for what a window opens on (`startOnHome` is ready for it); recent workspace pages from other
  devices are not shared (by design).

## Open questions

- Whether signing out should clear the web's recent list as it clears the tabs (it does not now, matching favorites).

## Amendment (2026-10-28): on the desktop, Home is the Private Space picker — Proposed

The owner wants the logo to take people back to the "Meet Thoth" picker (choose or create a Private Space, with the
Recent list), not to a Home tab. Decisions, made for the owner:

1. **One action behind every Home entry point on the desktop:** the logo (the mark and "Thoth" at the top of the
   sidebar), the house at the start of the tab bar, Alt/Option+Shift+H (the shortcut id stays `home.open`) and the
   palette. They are named for what they do: "Back to Private Spaces" / "กลับไปที่ Private Space" (the logo:
   "Thoth, back to Private Spaces", so its name starts with the word shown). The icon stays a house. The palette
   command is its own action (`leaveSpace`, id `space.leave`) so the web's "Go home" is untouched.
2. **Nothing is lost:** leaving runs the same step as Settings' Switch Private Space, `Session.switchVault`, which
   writes every pending edit first (`flushAll`). It now answers whether it left: when an edit could not be written (a
   conflict, an error) the Private Space stays open, and the shell says so in its banner ("Your edits could not be
   saved yet, so this Private Space stays open. Check the open page, then try again.") next to whatever the editor shows (the conflict dialog).
3. **This window only:** the window closes its Private Space and shows the picker; other windows on it are left as
   they are. A window the app opened forgets it is on that Private Space (as before). Tabs are saved per Private
   Space and window on every change, so picking the same space again brings its tabs back.
4. **The picker lists the space just left first**, ahead of the host's order (the host orders by last opened, which
   another window may have changed), and focus starts on its main button.
5. **No Home tab on the desktop.** A saved layout (or the tabs a new window is opened with) that holds a Home tab
   opens without it (`parseDesktopLayout`); a layout of only Home opens on the first page. Rule 3 no longer applies
   on the desktop: a window with nothing to restore opens the first page by path, as before Home, and
   `AppOptions.startOnHome` is gone. A new tab shows an empty view ("New tab", and how to open a page) instead of
   Home's lists; Favorites stay in the sidebar. The desktop's recent-pages list (rule 6–7, `thoth.desktop.recent.*`)
   is removed with the view that showed it; old keys are left in `localStorage`, unread.
6. **The web keeps rules 1–8 as they are.** The shared pieces (`HOME`, the Home view, the recent store, the tab bar's
   house, "Go home") stay in `packages/app-ui` for it; the tab bar takes an optional `homeLabel`.
7. The first-run tour's step on the house and the logo now explains going back to Private Spaces.
8. The picker's small muted text (the hint, the Recent heading, the paths) uses the secondary ink: the tertiary was
   4.3:1 on Night, below WCAG AA for 12px text. Seen by the new axe check on the picker.

Consequences: Home on the desktop is now a way out of a Private Space, one click from any window; the desktop loses
the quick list of recent pages (search and Favorites remain). Open question: whether a new tab on the desktop should
list something again (recent pages, favorites) once the owner has used this.

## Amendment (2026-10-29): a new tab on the desktop lists recent pages and favorites again

The owner answered the open question above: yes. Decisions:

1. **A new tab shows the Home view** (the greeting, Recent and Favorites, rule 2) instead of the empty view of
   2026-10-28 rule 5. It stays a `blank` tab named "New tab"; there is still no Home tab on the desktop, and the logo,
   the house, Alt/Option+Shift+H and the palette still go back to the picker.
2. **The recent pages come back as before (rules 6–7):** per Private Space under `thoth.desktop.recent.<root>`, so
   what was kept before 0.2.2 shows again; they follow renames and moves with the tabs and drop pages that are gone.
3. A window with nothing to restore still opens the first page by path (2026-10-28 rule 5).

