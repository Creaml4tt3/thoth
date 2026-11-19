# Thoth as a second brain: roadmap

- **Date:** 2026-11-19
- **Status:** phone capture decided by the owner (A); the order is the Main Thread's proposal, not objected to; each phase gets its own design before it is built.
- **Source:** the owner's goal ("a fast, reliable and smart second brain, more advanced than a regular one") and the
  needs in the Game Pasut posts (Day 1 and Day 2 of 90, Obsidian vs Notion, and the Obsidian graph review):
  - one core of knowledge any AI can use;
  - seeing new connections across fields, like a graph or mind map;
  - an AI thinking partner or coach;
  - too lazy to type and decorate, so quick idea dumps;
  - capture on the phone (the reason for switching to Notion);
  - data must never be lost (2–3 backups).
- **Mockups:** `.superpowers/brainstorm/11459-1795092475/content/second-brain.html` (local, not committed).

## Order

Proposed order (the owner saw it on the mockup page and raised no objection): **0.12.0 → Reliable → Capture → Smart.** A second brain people can't trust won't get
used, and Smart gets better once more is captured.

| Release | Answers | Adds |
| --- | --- | --- |
| **0.12.0** | Look and feel, "a graph", text in images | Settings pages, Thoth select, Board (`2026-11-19-settings-select-board-design.md`); OCR Phase 0 test, then text from an image, plus scanned PDF to a page if Phase 0's numbers allow (`docs/architecture/ocr-plan.md`) |
| **Reliable** | "Never lose data" | Page history for Private Space pages (backlog: local version history, kept in the app data folder, ADR-0046) with compare and restore; a visible backup in Settings: last run, where, back up now, restore |
| **Capture** | Lazy, quick, phone | An **Inbox** in the sidebar; phone capture through an inbox folder (below); search inside images (OCR feature B, off by default); voice notes later, as the next download after OCR |
| **Smart** | New connections, a thinking partner | Related by meaning (local embeddings, a downloaded module like OCR) feeding Board's suggestions and a "Related" part in Connections; a weekly coach (the user's own Claude or Codex) whose suggestions wait for approval, as agent proposals do (ADR-0048) |

## Decided: phone capture is an inbox folder (option A)

Thoth makes a **Thoth Inbox** folder in the user's iCloud Drive or Google Drive. The phone sends to it with the
Share button or a one-tap Shortcut. Thoth on the computer notices new files and turns each into a page in the Inbox:
text into a page, a photo into a page with the photo and its OCR text, a link into a page with its link card.

- Days of work, no phone app, no server, works offline, and the files stay the user's.
- Limits accepted: notes arrive while the computer is on, and the phone can send but not read.
- Not now: a capture page on the user's Thoth server (B, weeks) and a phone app (C, months). The backlog keeps both.

## Not decided yet (each phase's design)

- Reliable: how many versions and for how long; where the backup goes (a second folder, a drive, the cloud folder)
  and whether Thoth runs it or checks an existing one.
- Capture: how the Inbox folder is chosen and watched (iCloud's placeholder files), what happens to a file after it
  is taken in, Shortcut and share-sheet setup.
- Smart: which embedding model (Thai and English, local, licence), and the coach's schedule and cost (the user's own
  agent account).
