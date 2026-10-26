# ADR-0018: Notifications

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** project owner (scope, implementation plan Track 4); the storage rule (6) and the content rule (5)
  were decided in this ADR within that scope.
- **Refines:** ADR-0007 (an agent run's outcome is told by the mascot), ADR-0006 (a transfer's result), ADR-0008
  (what the webview may call), ADR-0015 (what the web client keeps in the browser).

## Context

Agent runs, transfers and imports take from seconds to minutes, and people switch to another app meanwhile. A page
can also change on disk or on the server while it has unsaved edits (a save conflict, ADR-0005). Until now each of
these said so only on its own screen (the mascot's bubble, the transfer dialog, the import report, the conflict
dialog), which nobody sees from another app, and nothing kept a list of what happened.

Constraints: the Private Space is local-first and portable (nothing app-only in the vault); notifications appear on
the lock screen and in the OS's notification centre, where anyone near the screen reads them; the webview gets least
privilege (ADR-0008); the web client has no agents, imports or transfers.

## Decision

1. **Events.** Nine kinds:
   - an agent run ready for review (`agentReview`), finished without changes, which for a question means its answer is ready (`agentFinished`, "The answer is ready"), failed
     (`agentFailed`), or stopped at its time or spending limit (`agentLimit`, whether or not it left work to review);
   - a copy or move between the Private Space and a workspace done (`transferDone`, including "done, originals kept")
     or not finished (`transferFailed`: failed or interrupted);
   - an import complete (`importDone`) or finished with errors (`importFailed`, including one that stopped with an
     error);
   - a save conflict (`saveConflict`), in the Private Space or in a workspace.

   What the person did themselves says nothing: a cancelled run, opening an earlier run's review again, Apply and
   Discard, an undone transfer, a cancelled import.
2. **Where each shows.**
   - **In-app list**, every event: a bell in the sidebar (its accessible name and badge give the unread count), a list
     above it (a non-modal dialog right after the bell in the focus order; arrows move between entries, Esc closes and
     returns focus to the bell), "Mark all read", "Clear", and the palette command "Show notifications". An entry
     opens what it is about: the run's review or result (or its outcome in the bubble, or the history when the run is
     gone), the copied page or the original, the imported folder, the page with the conflict. New entries are said in
     a polite live region.
   - **The mascot**, agent run events: its state and its announcement (as before) plus a short message next to it
     ("Changes ready for review", "The run failed: Claude Code is not signed in"). The message takes no focus, closes
     by itself after 6 s (not while the pointer or focus is on it) and opens the run on click. Because the mascot says
     them aloud, the list does not announce agent events a second time; with the mascot switched off, the list does.
   - **System notifications** (desktop only), every kind: see rule 3.
3. **System notifications only in the background.** One is shown only while the window is not focused or is hidden,
   only when system notifications are on and its kind is on (Settings → Notifications; all on by default; per user,
   stored with the other desktop preferences, never in the vault). In the foreground the list and the mascot are
   enough. Through Tauri's official notification plugin (`tauri-plugin-notification` and
   `@tauri-apps/plugin-notification`, both pinned to 2.5.1, released 2026-10-01). The webview is granted exactly
   `notification:allow-is-permission-granted`, `notification:allow-request-permission` and `notification:allow-notify`;
   no listeners, channels or lists, no window permissions (a unit test holds this). The plugin is loaded, and the OS
   permission asked for, the first time a notification would be shown, never at start; after a refusal it is not
   asked again in that window.
4. **Clicks.** On the desktop the plugin shows a title and a body only: it reports no click (its action and listener
   APIs are mobile only; verified in its 2.5.1 source, `desktop.rs`). So Thoth cannot open the item from a click. On
   macOS a click on an app's notification brings the app to the front (the OS's behaviour); what it was about is the
   newest entry under the bell. Opening the item from the click itself waits for a plugin that reports clicks on the
   desktop (Open questions).
5. **What a notification may say.** Titles and names only: page titles, folder names, workspace names, the agent's
   name, counts, and fixed text chosen by Thoth. Never page text, the task (it may quote a page), agent output, or an
   error message from a server, a CLI or the disk (they can echo content); a failed run's reason is a fixed phrase
   chosen from its error code. This is enforced in the shared core, not by the callers: an event keeps only the
   fields of its kind, each name is one line of at most 80 characters, and at most three page titles are kept (the
   rest is a count). The same text is used in the list, the mascot's message and the system notification.
6. **Storage: in memory, per window.** The list lives in the window's memory and is gone when the window closes
   (at most 50 entries; a repeat of the same thing within a minute joins its entry quietly, a later one brings it back
   to the top, unread). Nothing is written to the vault, to the app's data folder or to browser storage. Reasons:
   the list holds page titles, which would otherwise sit outside the vault in another place to protect and clean up;
   everything an entry points to is kept already where it belongs (run history and reviews waiting from an earlier
   session, the transfer records and "originals kept" list, unfinished import jobs, the conflict dialog itself); and a
   list carried over from yesterday would mostly be stale. The OS keeps its own copy of shown system notifications
   under its own rules.
7. **The web client** has the list only: the bell, its list and the palette command, with the save conflict as its
   one event, kept in memory for the tab. It has no system notifications (no notifier, no browser `Notification`
   API, no permission request) and its production bundle contains no notification plugin (a build test holds this).
8. **Code.** `packages/app-ui/src/notifications/core.ts` (no React, no Tauri): the typed events, the content rule,
   the list (unread, de-duplication, cap, announcement), the background rule, and the `SystemNotifier` port with the
   plugin adapter and a no-op. `NotificationBell.tsx` is the shared bell. The desktop feeds it from the agents
   service, the transfer and import services and the page views, and passes the plugin notifier; the web passes none.

## Consequences

- Positive: a run, a transfer or an import that ends while the person is elsewhere is not missed; there is one place
  to find what happened in this window; nothing sensitive is put on the lock screen.
- Positive: no new storage to protect or clean up; nothing app-only in the vault.
- Negative: a click on a system notification does not open the item (rule 4); the list is empty after a restart (rule
  6). Accepted: the item is one click away under the bell, and what waits (reviews, originals kept, unfinished jobs)
  is still offered at start by its own feature.
- Negative: in a dev build on macOS the plugin posts as Terminal (the plugin's own choice); release builds post as
  Thoth.
- Follow-up: re-check the plugin's desktop click support on each release; a native reader for the Thai strings marked
  `REVIEW`; a person to check the look and the macOS permission prompt in a real window.

## Alternatives considered

- **Keep the list on disk (app data) for some days.** Rejected for now: it stores page titles outside the vault for
  little gain, since the things worth coming back to are already kept by their features (rule 6).
- **A toast for every event.** Rejected by the owner for agent runs (the mascot speaks for them); for the rest a
  toast would repeat what the dialog on screen already says, and the background case is the system notification.
- **Show the task or the first line of the agent's answer.** Rejected: both can carry page text (rule 5).
- **Send notifications from the Rust host** (a Thoth command, no plugin permission in the webview). Not chosen: it
  needs a new host command for the same three plugin calls, and the plugin's own permissions already limit the
  webview to exactly those. It would be the way to add click handling with a native API later.
- **Ask for the permission at start.** Rejected: people should be asked when it is about something.

## Spec references

Section 2 (local-first, Markdown as the source of truth), 10 (agents), 11 (transfers), 12 (import), 13 (web client),
14.11 (browser contexts). Implementation plan, Track 4.

## Open questions

- Opening the item from a click on a system notification on the desktop: needs a plugin (or a native API through the
  host) that reports clicks on macOS and Windows. Blocks only rule 4's full behaviour.
