# Thoth design system — "Papyrus Black"

Status: **Accepted** (v0.2, 2026-11-15, ADR-0053; v0.1 "Ink & Moon" 2026-10-20). Tokens: `packages/ui/src/tokens.css`.
Brand files: `design/brand/`. The early research, mockups and concept art are kept outside this repository.

## 1. Idea

Thoth, the Egyptian god of writing and knowledge, is a scribe with an
ibis head and a moon crown. The product is a calm place to write, inside a
cinematic, confident shell and agent surface.

Influences: the quiet pages of document editors such as Notion, and the dark,
cinematic look of today's AI product sites. Thoth takes a feeling from them,
not their assets or code, and builds it from its own idea: a scribe's paper
and ink by day, the night sky and the moon by night.

- **Papyrus**: by day, writing surfaces are papyrus paper `#FEFAF3` (sidebar
  `#F8F0E2`) with warm ink `#1F1B14`. Text steps down from one warm ink, the way
  ink thins on paper, never a set of cool greys.
- **Black**: by night, a soft ink black `#0E0C0B` with raised steps `#171514`
  and `#211F1C`, and warm text `#E8E2D8`. It is warm without reading brown.
- **Moon**: the brand anchor, lunar orange `#E8590C`: primary actions, the
  mark, the agent avatar, running badges and focus. As text it uses its role
  tones, `#B64201` on paper and `#FF8C5F` on black.
- **Blue, secondary only**: links, Workspace badges, your own chat messages and
  tonal buttons (`#3F6088` / `#A5CAF7`). Never a page fill or a primary action.
- **Colour that means something**: the eight folder and tag colours, callouts
  and status use Material-style tonal ramps (ADR-0053 rule 4). Colour is never
  the only signal: a badge also has a word, a status also has an icon.

Space types have their own badges, so users always know where content lives,
which matters for the private-to-workspace transfer UX:

| Space | Badge | Colour |
|---|---|---|
| Private Space | `Local` | warm ink variant (`--thoth-text-secondary`) |
| Workspace | `Workspace` | secondary blue |
| Agent Hub | `Running` | moon |

## 2. Mark: Moon Ibis

The mark is a full lunar disc (Thoth's moon crown) with the ibis head, neck
and long decurved beak cut out as one negative-space silhouette, plus the eye
as a disc island. It is a single closed shape, monochrome, and uses
`currentColor`.

| File | Use |
|---|---|
| `mark.svg` | Inline UI; inherits `color` |
| `mark-white.svg`, `mark-ink.svg` | Fixed-colour exports |
| `favicon.svg` | ≤16px. Same shape with a slightly larger eye (r 16 instead of 11.4) so the eye still reads at 16px. |
| `app-icon.svg` | The app icon (since 2026-11-16, the owner's pick "B2"): the mark in paper `#FFF8F1` on a Moon tile lit from the top (`#F7752E` to `#D84D0B`, a faint top glow, a thin light edge). The light is on the tile, never on the mark. |
| `app-icon-dark.svg`, `app-icon-light.svg` | Earlier 1024 tiles, Night or Paper; kept for the site and press until they move to `app-icon.svg` |

Rules:

- Minimum size is 16px (favicon variant) or 20px (full mark).
- Clear space is ¼ of the disc diameter.
- The beak always points right, toward the text and reading direction.
- Never outline, rotate, or put a gradient on the mark. Never place it on
  busy imagery.
- In the hero, the mark sits **inline in the headline** at cap height
  ("Meet ◐ Thoth"), so the moon rises in the sentence itself.
- Wordmark: "Thoth" in the UI sans, weight 600, tracking −0.03em. The gap
  between mark and word is 0.35× the mark size.

Verified rendering: 256 / 96 / 48 / 24 / 16px on Night and Paper. Not yet done:

- ~~PNG/ICNS/ICO rasters.~~ Generated from `app-icon.svg` with `resvg` and `tauri icon` (2026-11-16).
- An optical-weight review by a human designer.

## 3. Type

- **Sans**: Inter Variable, with Noto Sans Thai as fallback (Thai is a
  first-class script in fixtures and search): a plain, readable family that
  stays out of the way of writing. Headlines get their confidence from the
  `display` token: 600 weight, −0.035em.
- **Serif (optional reading mode)**: Newsreader / Noto Serif Thai, per page.
- **Mono**: JetBrains Mono for code, diffs and agent logs.

| Token | Spec |
|---|---|
| display | 600, 40–72px, 1.02 |
| h1 / h2 / h3 | 40 / 28 / 20px, weight 600 |
| body | 16px / 1.65 |
| UI | 14px / 20px |
| small | 12px |

The editor's content column is 720px.

## 4. Shape and depth

- Content (blocks, menus, inputs) uses small radii: 4, 6, 8 and 12px, so
  text keeps the straight edges of a page.
- **Actions** (buttons, chips, context pills, CTA) are full pills (9999px),
  round like the moon, so anything that does something reads apart from content.
- Feature cards and the marketing window use a 20px radius.
- Use hairline borders first (9% ink). Shadows are only for floating layers
  (popover, modal).

## 5. Where each influence applies

| Surface | Base theme | Notes |
|---|---|---|
| Marketing site | Follows the system (Papyrus or Black) | Hooded ibis in front of its moon, Moon pill CTA, notebook-cover intro |
| Editor, sidebar, page views | Follows the chosen theme | Document layout: sidebar 260px, breadcrumbs (no `.md`), properties row, callouts on a warm tint; page title 32/700, H2 22/600; the current tab filled with Moon; selection otherwise neutral (ADR-0053 amendment 2026-11-16) |
| Onboarding, import wizard | Follows the chosen theme | Moon primary pill, secondary tonal pills |
| Agent Hub, agent side panel | Follows the chosen theme | Your messages in the secondary container; the agent's answers on the container in ink with a 3px Moon rule at the left (calmer than a Moon wash in long chats; owner's pick 2026-11-15); Apply/Discard pills |
| Transfer review (Private → Workspace) | Modal on the raised step | Shows destination workspace and members before commit (spec §12) |

## 6. Accessibility

- Every text and background pair is checked by `packages/app-ui/test/contrast.test.ts` (AA: 4.5:1 text, 3:1 large
  text, meaningful borders and focus rings) in light, night and system-dark. A new pair gets a check in the same commit.
- Body text: ink on papyrus and warm text on black are both above 15:1.
- The `#E8590C` seed is about 3.4:1 on papyrus, so it is a fill, never small text. Small orange text uses the role
  tone (`#B64201` light, `#FF8C5F` dark).
- Focus rings use the moon colour, 2px, with a 2px offset.
- Night ink is a real two-step ramp: primary 0.94, secondary 0.82, tertiary 0.66 of the warm ink. Tertiary is the AA
  floor (4.62:1 at worst, over the Moon wash on the sidebar); the selected row is a translucent Moon wash
  (`rgb(232 89 12 / 0.31)`, the lowest alpha that still stands out from the page at 1.5:1) with `#FFDBCE` text on it.
- Light selected-row text (`--thoth-accent-ink`, `--thoth-moon-ink`) is a mid Moon brown `#7A2E00` (7.1:1 on `#FED7C9`)
  where a Moon wash is still used (menus' current item, chips). The tree, favourites and settings select with the
  neutral `--thoth-bg-active` since 2026-11-16 (ADR-0053 amendment).
- The current tab is a Moon fill with `--thoth-on-accent` text (white on `#B64201`, `#370E00` on `#FF8C5F`), both
  above 4.5:1; its focus ring switches to `--thoth-on-accent` so it stays visible on the fill.
- `prefers-reduced-motion` removes motion: the motion duration and distance tokens become 0, and `ui.css` forces
  animation and transition off everywhere in the app.

### Motion

Calm, quick and purposeful (tokens and rules: the "Motion" note in `packages/ui/src/tokens.css`).

- Durations: instant 80ms (dense list hover), fast 140ms (menus, tabs, tree, page fade), base 200ms (dialogs, banners),
  slow 280ms (first-run screens only). An exit is a step shorter than its enter.
- Easings: ease-out for arriving, ease-in for leaving, an overshoot-free spring for dialogs.
- Only transform and opacity move; the exceptions are the grid row of an opening tree folder and a tab's width.
- Never animated: typing, the caret, list rows, filtering, keyboard navigation inside a list, focus rings.

## 7. Open design questions

- ~~Moon Ibis or an alternative direction?~~ Decided 2026-10-22: Moon Ibis
  (direction A).
- ~~Orange or silver-blue accent?~~ Decided 2026-10-22: lunar orange. Silver-blue
  was too close to the Workspace badge blue.
- ~~A richer, more colourful system?~~ Decided 2026-11-12/15: Papyrus Black (ADR-0053).
- ~~New app icons in Papyrus Black?~~ Decided 2026-11-16: the Moon tile `app-icon.svg` (option B2). The favicon stays
  the plain mark for now.
- Do we license a custom display face later? For now, Inter is a deliberate,
  free choice for an OSS project.
