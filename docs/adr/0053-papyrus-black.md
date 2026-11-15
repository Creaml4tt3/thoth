# ADR-0053: Papyrus Black, the colour system for the app and the site

- **Status:** Accepted (owner). The owner chose the direction on 2026-11-12 ("make dark mode beautiful black then use
  blue as secondary only"), approved the site in it on 2026-11-13 (live as thoth-site 9d2991f), and on 2026-11-15
  asked for the app rollout.
- **Date:** 2026-11-15
- **Deciders:** project owner (the direction, sans headlines, blue as secondary only); the role mapping and the
  checks are this ADR's.
- **Supersedes:** `design/DESIGN.md` v0.1 "Ink & Moon" for colour: the pure white paper, the `#0A0A0A` night and the
  rule "one accent, used sparingly". The mark, the type families, the shapes and the motion rules stay.
- **Refines:** ADR-0016 (themes: the values `light`, `dark` and `system` and the `data-theme` names stay), ADR-0037
  (folder colours: the eight names stay; their values move to the new ramps).
- **Research:** `docs/design/research/2026-11-redesign-research.md`, `2026-11-orange-sites-and-loved-sites.md`,
  `2026-11-pinterest-orange-combos.md`, `2026-11-awwwards-mobile-apps.md`. Directions and the palette script:
  `docs/design/directions/` (`palette.py`, direction `black`).

## Context

The owner found Ink & Moon plain ("not boring", "make our brand stronger") and asked for a richer, more colourful
system built the way Material's colour article describes: tonal palettes and roles rather than single hex values.
Of seven directions, the owner leaned to Papyrus (warm paper by day), then asked for a dark mode that is "beautiful
black" with blue only as a secondary colour. Every orange-brand site measured (Replit, Cloudflare, Claude, Postman
and others) uses a warm off-white and a warm near-black; none uses pure `#FFF` or `#000`.

## Decision

1. **Two grounds.** Light is papyrus paper `#FEFAF3`, with the sidebar one step deeper (`#F8F0E2`). Dark is a soft
   ink black `#0E0C0B` (papyrus hue at almost no chroma, so it reads warm without reading brown), with raised steps
   `#171514` and `#211F1C`. Text is warm ink: `#1F1B14` on paper and `#E8E2D8` on black.
2. **Moon stays the anchor.** Seed `#E8590C`. It is the brand fill (primary buttons, the mark, the agent avatar,
   running badges). As text and thin lines it uses its role tones: `#B64201` on paper and `#FF8C5F` on black, so small
   orange text always passes AA. Its containers are `#FFDBCE` / `#7E2C01`.
3. **Blue is the secondary role only:** links, Workspace badges, the user's own chat messages and tonal buttons.
   `#3F6088` on paper, `#A5CAF7` on black, containers `#D0E5FE` / `#28486E`. Blue never fills a page or a primary
   action.
4. **Colour is allowed where it means something.** This replaces "one accent, used sparingly": the eight ADR-0037
   accent names (gray, brown, orange, yellow, green, blue, purple, red) get Material-style ramps with `fg`, `soft`,
   `on_soft` and `dot` tones per theme, for folders, tags and callouts. Success, warning and info get the same shape.
5. **Roles, not hex values, in components.** Components use the `--thoth-*` variables in
   `packages/ui/src/tokens.css`. Existing names keep their meaning and only change value; new roles (the secondary
   and its container) are added beside them. No component hard-codes a colour.
6. **Contrast is a test, not a review.** `packages/app-ui/test/contrast.test.ts` checks every text and background
   pair the roles produce, in `light`, `night` and system-dark: 4.5:1 for text, 3:1 for large text, borders that
   carry meaning and focus rings. `docs/design/directions/palette.py` fails the build of the previews on the same
   pairs.
7. **Type stays sans.** Inter Variable with Noto Sans Thai, headlines 600 with tight tracking. The serif reading mode
   stays optional.
8. **Unchanged:** the Moon Ibis mark and the app's Moon Crown mascot (a change of mascot would be its own ADR), the
   theme values users have saved, the motion rules, and the brand files and app icons (new icons need a regenerated
   set with `tauri icon` and are done only if the owner asks).

## Consequences

- One look across the site and the apps. The site has used these roles since 2026-11-13.
- The 0.10.0 release carries the change; the release post explains it.
- Hard-coded colours outside the tokens become bugs to fix in the rollout.
- Screens that sat on Night in both themes (the Agent Hub) follow the chosen theme's black or paper unless the
  rollout finds a reason to keep them dark; that choice is recorded in DESIGN.md.

## Open questions

- New app icons and favicon in Papyrus Black: only if the owner asks.
- A licensed display face: still Inter for now.
