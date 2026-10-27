# ADR-0015: Website, trial-only web client, and analytics

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** project owner
- **Refines:** ADR-0013 rule 3 (the website), ADR-0014 (trial hosting).

## Context

Phase 2c builds the website at `thothnotes.com`: a landing page and the
web client at `/app`. ADR-0013 rule 3 said the web client "connects to any
Thoth server the user names and defaults to the trial server". The owner
decided on 2026-10-24:

1. The web client connects **only to the owner's trial server**.
2. The website is in **English and Thai**.
3. The landing page shows a **showcase video with motion and sound**, made
   for the project: real app footage, motion titles, and an original
   soundtrack. It has no spoken voice, because the system voices available to
   us are licensed for personal, non-commercial use only.
4. **Google Analytics 4** runs on the website and, anonymously, in the web
   client, to improve features and UX. The site is built for search (SEO),
   answer engines (AEO) and generative engines (GEO).
5. The owner is in **Thailand**, so the legal pages follow Thailand's
   Personal Data Protection Act (PDPA).

The desktop app stays local-first: the Private Space needs no network, and the
app sends nothing unless the user connects to a server.

## Decision

1. **Web client: trial only.** The trial server's address is fixed at build
   time (`VITE_DEFAULT_SERVER`). There is no field to connect elsewhere.
   Self-hosters use the desktop app, or build and host the web client with
   their own address. Sign-in uses the `thoth-web` client of
   docs/protocol/sign-in.md: the refresh token is an `HttpOnly` cookie, the
   access token lives in memory only, and nothing is kept in `localStorage`.
2. **Languages.** Every website page exists in English (`/`) and Thai
   (`/th/`), linked with `hreflang` (plus `x-default`). The web client follows
   the browser's language and has a switch.
3. **Search, answers and generative engines.**
   - Every page is static HTML with its content in the markup, not rendered by
     script.
   - Each page has a title, a description, a canonical URL and Open Graph and
     Twitter cards.
   - Structured data (JSON-LD): `SoftwareApplication`, `Organization`,
     `WebSite`, `FAQPage` and `VideoObject`.
   - The site serves `sitemap.xml`, `robots.txt` and `llms.txt`.
   - Short, factual answers (what Thoth is, how it differs, how to
     self-host) appear as plain text that a crawler can quote.
   - The web client (`/app`) is `noindex`.
4. **Analytics (GA4).**
   - GA4 loads **only after the visitor consents** (PDPA). Google Consent
     Mode v2 defaults every storage type to `denied`. Before consent, no
     request goes to Google. The banner offers Accept and Decline equally, and
     the choice can be changed later from the footer.
   - **Website:** page views and named events (video play and progress,
     download and self-host clicks, language switch, sign-in started).
   - **Web client:** anonymous events only: screen names (`/app`,
     `/app/page`) and actions (`sign_in`, `page_open`, `page_save`,
     `conflict_shown`, `conflict_resolved`, `search`).
     - Never sent: page titles, page or workspace IDs, URLs with IDs, search
       text, names or email addresses.
     - `page_location` and `page_title` are replaced with the screen name.
     - No user ID is set, and Google signals and ad personalisation are off.
   - The measurement ID comes from build configuration (`VITE_GA4_ID`).
     Without it, analytics code is not loaded at all. Self-hosted builds have
     no analytics unless their owner sets one.
   - **The desktop app sends no analytics.**
5. **Showcase video.**
   - Content: footage recorded from the real app by a script, motion titles,
     an original soundtrack and soft interface sounds, all made for the
     project and owned by it. There is one render per language: English and
     Thai titles.
   - Playback: the video autoplays muted and loops on the page. Sound plays
     after the visitor presses play. Captions and a text summary are
     provided for accessibility and for search.
   - Formats: MP4 (H.264/AAC), WebM and a poster image. A
     `prefers-reduced-motion` visitor sees the poster with a play button.
6. **Legal pages.** The privacy notice and terms on the website cover the
   trial and the website, under Thai law (PDPA). The privacy notice covers
   analytics and the consent choice.

## Consequences

- Positive: the trial is a simple, safe demo, with no CORS or cookie setup for
  arbitrary servers.
- Positive: analytics answers which features people use without collecting
  workspace content.
- Negative: self-hosters do not get a hosted web client. They use the desktop
  app or host their own build.
- Negative: GA4 adds a third-party processor (Google) and a consent banner.
  The privacy notice must say so.
- Follow-up: Phase 2c AC in docs/architecture/implementation-plan.md; the
  privacy notice and terms in `docs/legal/` and on the website.

## Alternatives considered

- **Web client for any server.** Rejected by the owner. It needs every
  self-hoster to allow the website's origin (CORS and `WEB_REDIRECT_URIS`).
- **Self-hosted analytics (Plausible, Umami).** GA4 was the owner's choice;
  cookie-free analytics remain an option if consent rates are low.
- **A narrated video with system voices.** Not allowed for public commercial
  use under the voices' licence. A recorded human voiceover can be added
  later.

## Spec references

Section 2 (local-first), 12 (browser sessions, privacy), 13 (P2 web client).
