# Thoth design system — "Ink & Moon"

Status: **Accepted** (v0.1, 2026-10-20; mark and accent confirmed by the owner 2026-10-22). Tokens: `packages/ui/src/tokens.css`.
Brand files: `design/brand/`. The early research, mockups and concept art are kept outside this repository.

## 1. Idea

Thoth, the Egyptian god of writing and knowledge, is a scribe with an
ibis head and a moon crown. The product is a calm place to write, inside a
cinematic, confident shell and agent surface.

Influences: the quiet pages of document editors such as Notion, and the dark,
cinematic look of today's AI product sites. Thoth takes a feeling from them,
not their assets or code, and builds it from its own idea: a scribe's paper
and ink by day, the night sky and the moon by night.

- **Ink**: writing surfaces are warm paper with black ink. Text steps down
  in opacity (94 / 66 / 46 / 28%) from one warm black, the way ink thins on
  paper, never a set of cool greys.
- **Night**: chrome for marketing, onboarding and the Agent Hub is the night
  sky: a near-black `#0A0A0A`, white pill actions, and medium-weight display
  type with tight tracking.
- **Moon**: there is one accent, a warm lunar orange `#E8590C`. It means
  "the agent is here or touching this": the agent avatar, running badges,
  agent-proposed highlights, and focus. Use it sparingly; it is never
  decorative.

Space types have their own badges, so users always know where content lives,
which matters for the private-to-workspace transfer UX:

| Space | Badge | Colour |
|---|---|---|
| Private Space | `Local` | stone `#615D59` |
| Workspace | `Workspace` | link blue `#0B6BCB` |
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
| `app-icon-dark.svg`, `app-icon-light.svg` | 1024 squircle tiles: Night or Paper |

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

- PNG/ICNS/ICO rasters. No SVG rasterizer is installed. Generate them in the
  Tauri phase with `tauri icon`.
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
| Marketing site, onboarding, import wizard | Night | Centred hero, muted lede, inverted white pill CTA, product window |
| Editor, sidebar, page views | Paper (light) by default; Night available | Document layout: sidebar 260px, breadcrumbs, properties row, callouts |
| Agent Hub, agent side panel | Night in both themes | Chat bubbles, diff review, Apply/Discard pills, moon avatar |
| Transfer review (Private → Workspace) | Paper modal | Shows destination workspace and members before commit (spec §12) |

## 6. Accessibility

- Body text contrast: ink-primary on paper is about 17:1; on night it is about 18:1.
- Ink-tertiary (46%) is for meta text only, at 12px or larger.
- Moon on white is about 3.9:1, so it is not used for text. Use
  `--thoth-moon-ink` (`#8A3200`) for text on `moon-soft` instead.
- Focus rings use the moon colour, 2px, with a 2px offset.
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
- Do we license a custom display face later? For now, Inter is a deliberate,
  free choice for an OSS project.
