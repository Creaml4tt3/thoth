# ADR-0020: Links from pasted URLs and link previews

- **Status:** Accepted (owner, 2026-10-26)
- **Date:** 2026-10-26
- **Deciders:** project owner (the request, 2026-10-25, implementation plan Track 6); rules 1 to 6 were decided by
  the orchestrator for the owner. The details marked "(this ADR)" were decided while implementing them.
- **Refines:** ADR-0002 (serialization: a pasted link is written in the usual link form), ADR-0008 (the webview
  has no network; the host makes every request), ADR-0012 (Plain mode is left alone), ADR-0015 (the web client),
  ADR-0016 (the link mark).

## Context

The owner asked on 2026-10-25: "when the user pastes URLs, make them links automatically; if a link has an OG
preview, show the link with the OG preview."

Constraints:

- Markdown is the source of truth (ADR-0002). Untouched text round-trips byte for byte, and nothing app-only goes in
  a file. A preview cannot be stored in the page.
- The desktop webview has no network (ADR-0008). The CSP is `connect-src ipc:` and `img-src 'self' data: blob:`, and
  there is no http or opener plugin. Only the Rust host can fetch a page, and an image can reach the webview only as
  `data:` or `blob:`.
- Fetching a link on someone's behalf is a server-side request forgery risk. A page, or a redirect from it, can point
  at `127.0.0.1`, the router, `169.254.169.254` or a `.local` printer. A name can resolve to a public address when
  checked and a private one when connected (DNS rebinding).
- A fetch tells the site that someone looked. Links in a workspace page were written by other people.
- The web client talks only to the Thoth server (ADR-0015). An Open Graph proxy there would be an SSRF hole on the
  shared trial server.

## Decision

1. **Paste makes links** (Blocks mode, desktop and web).
   - One `http(s)` URL pasted over selected text links that text. With no selection it is inserted as a link whose
     text is the URL. `www.…` and `mailto:…` count as one link too.
   - Pasted text that contains URLs: each bare `http(s)://…` or `www.…` becomes a link, found by GitHub's
     extended-autolink rules.
     - A link starts at the start of the text, after white space, or after `*`, `_`, `~` or `(`.
     - The domain has a dot, and no `_` in its last two parts.
     - `? ! . , : * _ ~` at the end are left out, and so is an unmatched `)` or an entity-like `&x;`.
     - The rest stays text.
     - A `www.` link gets `https://`, where GitHub uses `http://` (this ADR).
   - Nothing changes inside code (a code block, inline code). Cmd/Ctrl+Shift+V pastes plain text with no linking.
   - The paste and the linking are two undo steps: one undo turns the link back into the pasted text.
   - Only `http:`, `https:` and `mailto:` become links. A link in pasted HTML with any other address (`javascript:`,
     `data:`, `file:`, relative) loses its link and keeps its text (this ADR). Before this, such a link was kept.
   - The Markdown written is the serializer's usual form: `<https://…>` when the text is the address, else
     `[text](href)`. Untouched blocks keep their bytes.
   - Plain mode inserts the text unchanged (CodeMirror's `pasteURLAsLink` stays off). Markdown viewers already show
     bare URLs as links.
2. **Preview card.**
   - A paragraph whose whole content is one `http(s)` link (the usual result of pasting a URL on its own line) shows a
     card under the link. The card has the site name, the title, the description (two lines) and the image if any.
     There is no favicon.
   - The card is a widget decoration, not part of the document. The Markdown is not changed and the page is a plain
     link everywhere else.
   - The card is shown only when the page gave a title or a description. A failed fetch shows the plain link.
   - A bare URL that is plain text in the file (a GFM autolink literal, kept as text by ADR-0002's parser) gets no card
     (Open questions).
   - A menu on the card has three items:
     - "Show as link" hides the card for that link on that page. It is remembered in the app's own storage
       (`localStorage` in the app data folder, at most 200 pages × 100 links), never in the vault.
     - "Open" (through the host).
     - "Copy link".
   - The menu button and its items are ordinary buttons. Arrows move in the open menu, Escape closes it and returns to
     its button, and Tab leaves it: there is no focus trap.
3. **Who fetches: the desktop host only**, never the webview and never the Thoth server. Three host commands, each
   granted to the webview by name and nothing else (no plugin):
   - `link.preview(url)` returns `{ url, finalUrl, siteName?, title?, description?, image? }`. The image is a `data:`
     URL. Errors are typed: `BAD_ARGUMENT` (not a link), `NOT_ALLOWED` (a scheme, credentials or an address the rules
     refuse), `PREVIEW_UNAVAILABLE` (no answer, an error status, not HTML, too slow, too many redirects). Messages name
     the origin only, never a path or a query.
   - `link.preview.clear()` empties the cache (rule 6) (this ADR).
   - `link.open(url)` opens an `http(s)` link in the system browser. The webview has no opener (this ADR).

   The web client shows plain links: it has no card, and its bundle has no `link.preview` (a build test holds this).
4. **Fetch rules** (`crates/thoth-host/src/links`). Each rule has a test in `crates/thoth-host/tests/links.rs` or a
   unit test beside it.
   - Schemes: `http`/`https` only. A URL with a user name or password, or longer than 2048 bytes, is refused. Its
     `#fragment` is not sent.
   - Headers: no cookies (ureq has no cookie jar; `Set-Cookie` is ignored), no `Authorization`, no `Referer`, no proxy
     from the environment. The `User-Agent` is fixed: `Thoth/<version> (link preview)`.
   - Addresses: public only. Refused:
     - loopback, private (RFC 1918, IPv6 ULA), link-local (cloud metadata), CGNAT (100.64/10), multicast, broadcast,
       unspecified, documentation, benchmarking and reserved ranges;
     - IPv4-mapped and IPv4-compatible IPv6 addresses, and NAT64 and 6to4 addresses, of any refused IPv4 address;
     - IPv6 outside 2000::/3 (and Teredo and ORCHID);
     - the names `localhost`, `*.localhost` and `*.local`, before any lookup.
   - DNS: the check is made after the lookup, for every connection, each redirect included. The address checked is the
     address connected to: each hop's ureq agent gets a resolver that returns exactly the checked addresses, so the
     name is not looked up again (no DNS rebinding). A name with both public and private addresses connects to the
     public ones only.
   - Redirects: at most 5, each target checked like the first.
   - Time: 5 s in total for the whole preview, page and image together, the lookup included.
   - Size: at most 512 KB of HTML is read, and reading stops after `</head>`. Only `text/html` is accepted.
   - Fields read: `og:title`, `og:description`, `og:site_name` and `og:image`, with `twitter:` fallbacks and
     `<title>`. Only `<meta>` and `<title>` in the head count; comments, `<script>`, `<style>`, `<noscript>` and
     `<template>` are skipped.
   - The image follows the same network rules and a 2 MB limit. Only PNG, JPEG, GIF or WebP, judged by their magic
     bytes and never by `Content-Type`, are kept, as a `data:` URL; SVG is never kept. A failed image leaves the
     preview without one.
   - Text:
     - decoded as UTF-8, or as Latin-1 when the charset says so (this ADR: no other charsets, no `<meta charset>`
       sniffing);
     - entities decoded;
     - control and bidirectional-override characters removed, white space collapsed;
     - cut to 200 characters (title), 300 (description) and 80 (site).
   - Everything from the page is untrusted text. The webview sets it as `textContent` only, and shows only a
     `data:image/(png|jpeg|gif|webp);base64,` image.
   - Load: at most 4 fetches run at once in the host and 3 per window (this ADR).
   - Test switch: the stdio harness's `--link-preview-loopback` (`HostConfig.link_preview_loopback`) lets loopback
     addresses through, for a local test server, and nothing else. It works like `--agent-search-dir`. The desktop
     shell hard-codes `false` and the flag exists only in the harness binary, which is never bundled (a test holds
     this).
5. **When to fetch.**
   - A link you paste: at once, unless previews are Off. That applies to a paste in a workspace page too, since the
     link is your own (this ADR).
   - Links already in a Private Space page: when the page is shown.
   - Links in a workspace page (written by others): no automatic fetch. The card offers "Load preview".
   - Settings → Editor → "Link previews" has three choices:
     - On (the default).
     - Only for links I paste: links that were already there offer "Load preview" (this ADR).
     - Off: plain links, no fetch.

     The choice is stored with the other editor preferences.
   - A preview loaded once in a window is shown on any page of that window without another fetch.
6. **Cache.**
   - Where: `<app data>/link-previews/`, never in the vault. One file per URL (SHA-256 name), replaced atomically, in a
     folder with mode 0700.
   - How long: 7 days for a preview, 1 hour for a failure (`NOT_ALLOWED` or `PREVIEW_UNAVAILABLE`), so a dead site is
     not asked on every view.
   - How much: at most 500 entries and 20 MB, least recently used first.
   - An entry whose URL does not match, or whose error code is not one of those two, is ignored and removed.
   - "Clear link previews" in Settings empties it (`link.preview.clear`).
   - A host without an app data folder has no cache.

## Consequences

- Positive: pasting a URL gives a link with no Markdown syntax to learn. The file stays portable, the card adds
  nothing to it, and Plain mode is untouched.
- Positive: the only new network path is in the host, with one set of rules that every hop and the image go through,
  tested against a local server and a fake resolver.
- Positive: pasted HTML can no longer make a `javascript:` or `file:` link (a hole before this change).
- Negative: each preview fetch tells a site that the person looked (rule 5 limits when). The cache keeps titles and
  images of linked pages in the app data folder for up to 7 days; "Clear link previews" removes them.
- Negative: the web client has no cards (rule 3) and the decision on a server-side proxy is still open.
- Negative: pages in other charsets (Shift-JIS, GBK, …) may show garbled titles: there is no charset decoder.
- Negative: "Show as link" is keyed by the page's path, so it is forgotten when the page is renamed or moved.
- Follow-up:
  - a person checks the card, its menu and Cmd/Ctrl+Shift+V in a real Tauri window on macOS and Windows;
  - a native reader for the Thai strings marked `REVIEW`.

## Alternatives considered

- **Fetch from the webview.** Rejected: it would need `connect-src https:` and `img-src https:`, giving the page
  network access (ADR-0008) and leaking the user's IP and cookies to every image host.
- **An Open Graph proxy on the Thoth server for the web client.** Not chosen: on the shared trial server it is an SSRF
  and abuse risk. Left to the owner (Open questions).
- **Store the preview in the Markdown** (a custom block or an HTML comment). Rejected: it puts app data in the file
  and would make other apps show it as text.
- **One command (`link.preview`) only.** Not possible: clearing the host's cache and opening a link in the browser
  both need the host, since the webview has no opener and no file access. Each of the three commands is narrow.
- **Refuse a name when any of its addresses is private.** Not chosen: connecting only to the public ones is as safe,
  and a name can have both kinds of address.
- **An HTML tokenizer crate.** Not needed: a small scanner that reads `<meta>` and `<title>` from the head is enough,
  survives broken markup (tested), and adds no dependency.

## Spec references

Section 2 (locked decisions: Markdown as the portable source of truth, local first), 13 (web client), 14.11
(browser contexts and least privilege). Implementation plan, Track 6.

## Open questions

- **Previews in the web client.** It would need a server-side fetcher with the same rules, plus rate limits and abuse
  controls on the trial server. Blocks only previews on the web.
- **Cards for bare URLs in files.** A bare `https://…` that another app wrote is text in the content model
  (ADR-0002), so it has no card. Showing one would mean treating GFM autolink literals as links in the editor. Blocks
  nothing.
- **Cmd/Ctrl+Shift+V in the macOS app.** WKWebView may not send a paste event for Cmd+Shift+V without a "Paste and
  Match Style" menu item. Plain paste is implemented and tested in Chromium, but this needs checking in the real app.
  Blocks only that shortcut on macOS.
- **Other charsets.** Should the host decode Shift-JIS, GBK and others (an `encoding_rs` dependency)? Blocks nothing.
