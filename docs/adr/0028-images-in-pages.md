# ADR-0028: Images in pages

- **Status:** Proposed
- **Date:** 2026-10-26
- **Deciders:** owner (bug report), orchestrator (brief), implementation agent

## Context

An agent wrote `bird-uric-acid.svg` next to a page and put `![…](bird-uric-acid.svg)` under its heading. The desktop
app showed the browser's broken-image icon. Imported pages had the same problem: importers keep relative image links
(Notion `../attachments/<uuid>/<name>`). The editor rendered a bare `<img src="…">`, which the webview resolves against
the app's own origin. The webview has no file or network access (ADR-0008; desktop CSP `img-src 'self' data: blob:`),
and that must not change. There was also no way to add an image (the plan deferred `/` Image until an attachments
design existed).

## Decision

1. **Bytes come from the page's space, never from the DOM.** The image and inline-image node views
   (`app-ui/src/editor/image-views.ts`) ask `ctx.media()` (a `PageMedia`) for the bytes of `src`. They show the bytes from
   a `blob:` URL with the image's MIME type. The `src` written in the page is never given to an element. A blob URL is
   revoked when its node is destroyed or its `src` changes.
2. **What a `src` may point at** (`resolveImageSrc`, `app-ui/src/editor/media.ts`, pure):
   - A relative path is resolved against the page's folder after `%xx` decoding, and ignores `?query` and `#fragment`.
     `..` is followed while it stays inside the vault.
   - These are refused: a path that leaves the vault, absolute paths (`/…`, `//…`, `C:\…`), `file:` and other schemes
     (`data:`, `javascript:`, …), Thoth's own `.thoth/` folder, and an escaped `/` or `\` (`%2F`, `%5C`).
   - `thoth:attachment/<UUIDv7>` (the link form transfers already write, `transfer/src/links.ts`) is a workspace
     attachment. A workspace page has no folder, so a relative `src` there is "not found".
   - `http(s)` images are **never loaded**, for privacy and because the webview has no network. Their alt text and
     address are shown as a link. It opens in the browser through the host (`links.open`) on the desktop, and as a
     new-tab link on the web.
3. **Limits.** Only image types are shown: png, jpeg, gif, webp, avif, svg, bmp and ico. A vault file's type comes from
   its extension; an attachment's from its stored type. The cap is **20 MB**, checked before reading where the size is
   known and again after reading.
4. **SVG safety.** An SVG is only ever an `<img>` from a blob URL. In that mode its scripts do not run and its external
   loads do not happen, and its markup is never put into the DOM. The e2e test seeds an SVG with a `<script>` and an
   external `<image href>`, and checks that nothing ran and nothing was requested.
5. **States.** Each state shows something different:
   - Loading: a quiet placeholder with the alt text. If the image was shown before in this editor, its last height is
     reserved.
   - Missing or not loadable: a small placeholder that names the file ("Image not found: bird.svg"; "too large",
     "not an image", "outside this space" and "could not read" are worded the same way).
   - Bytes that do not decode: shown as "could not read", never the broken-image icon.
   - Recovery: when the index changes (a save, a file added outside), missing and unreadable images try again. A shown
     image is not reloaded until the page is reopened.
6. **Adding an image** (`app-ui/src/editor/image-insert.ts`), Blocks mode, editable pages only:
   - Three ways in: `/` **Image** ("รูปภาพ"), which opens the picker; pasting image files; and dropping image files.
     The `/` item appears only where the space takes files and there is a picker.
   - **Private Space:** the file is copied next to the page under its own name. When that name is taken (compared
     case-insensitively), it becomes `name-2.png`, `name-3.png` … The copy is written through `Vault.writeFileAtomic`
     with `expectedHash: null`, so an existing file is never replaced.
   - **Workspace:** the file is uploaded as an attachment with an idempotency key and written as
     `thoth:attachment/<id>`. Only editors and owners can add; viewers cannot.
   - The image goes in as an image block with a relative, escaped `src` and an alt text from the file name (`-` and `_`
     read as spaces). An empty paragraph at that point becomes the image. Otherwise the image goes after that block.
   - Each image is one undo step. **Undo takes the image out of the page, but the copied file or the uploaded
     attachment stays.** Deleting a file the user may have reused elsewhere is not something undo should do. Unused
     files can be removed by hand.
   - A file that is not an image, or is over 20 MB, is refused with a visible message. Successes are announced in a live
     region.
7. **The host's image picker:**
   - `image.pick` shows a native file dialog filtered to the image types. It refuses non-images (`NOT_AN_IMAGE`),
     non-files and files over 20 MB (`TOO_LARGE`). It returns `{ image: handle, name, size }`.
   - `image.read { image }` returns the bytes once. The page never learns or names a path.
   - The stdio harness answers the picker with `--pick-image <path>`.
   - The web client uses its own `<input type=file>`.
8. **Dropped files on the desktop.** The windows turn off Tauri's native drag-drop handler (`dragDropEnabled: false`,
   and `disable_drag_drop_handler()` for Thoth's other windows). Files dropped from the system then reach the page as
   ordinary drop events with `File` objects, the user's own gesture, as in a browser. No path is passed.

   A window-level guard stops any file drop that a page did not take, so the window never navigates to a dropped file.
9. **Workspace downloads are binary.** `api.call` takes `responseBytes`, and the host then sends a successful body as
   base64 (`bodyBase64`) instead of lossy text. `WorkspaceClient.getAttachment` uses it. The web client allows `blob:`
   in its CSP `img-src`, only for blob URLs the page makes itself. The desktop CSP is unchanged.
10. **Markdown stays the same.** The node views change no attributes, so opening and saving a page with images keeps
    its source byte-identical (`editor-serialization.md`). Editing the alt text rewrites only that block, canonically.
    Plain mode shows the Markdown as it is.
11. **Alt text.** Two ways to edit it: "Edit alt text" in the image's block menu, or Enter on a selected image. Either
    opens a small field: Enter saves, Escape cancels, and focus returns to the image. Every image has an accessible
    name: its alt text, or "Image: <file name>" when the alt text is empty. Images fit the page (`max-width: 100%`,
    `height: auto`).

## Consequences

- Imported pages with relative images, and files agents write next to pages, now show.
- The host has two more commands, and the capability file grants them. The shell's drag-drop change affects every
  window. Internal drags (blocks, tabs, sidebar) were already HTML5 drags.
- Images are read on every open. There is no thumbnail cache.
- Not done:
  - Resizing or captioning images.
  - Inline images from `/` (added images are blocks).
  - Data-URI images (refused).
  - Removing files no page uses any more.
