# Thoth design system — "Ink & Moon"

Status: **Proposed** (v0.1, 2026-10-20). Tokens: `packages/ui/src/tokens.css`.
Brand files: `design/brand/`. Reference mockup: `design/mockups/ink-and-moon.html`.
Research: `design/research/notes.md`. AI concept art: `design/concepts/` (exploration only, not production assets).

## 1. Idea

Thoth, the Egyptian god of writing and knowledge, is a scribe with an
ibis head and a moon crown. The product is a calm place to write (Notion)
with a cinematic, confident shell and agent surface (Grok Bot).

- **Ink**: writing surfaces use warm paper and black ink. Text uses Notion's
  opacity ramp (94 / 66 / 46 / 28%) on a warm black base, not cool greys.
- **Night**: chrome for marketing, onboarding and the Agent Hub uses Grok
  Bot's near-black `#0A0A0A`, white pill actions, and medium-weight display
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
| `favicon.svg` | ≤16px. Drops the eye island, which disappears below 20px. |
| `app-icon-dark.svg`, `app-icon-light.svg` | 1024 squircle tiles: Night or Paper |

Rules:

- Minimum size is 16px (favicon variant) or 20px (full mark).
- Clear space is ¼ of the disc diameter.
- The beak always points right, toward the text and reading direction.
- Never outline, rotate, or put a gradient on the mark. Never place it on
  busy imagery.
- In the hero, the mark sits **inline in the headline** at cap height
  ("Meet ◐ Thoth"), mirroring Grok Bot's inline mascot.
- Wordmark: "Thoth" in the UI sans, weight 600, tracking −0.03em. The gap
  between mark and word is 0.35× the mark size.

Verified rendering: 256 / 96 / 48 / 24 / 16px on Night and Paper (see
`design/research` and the mockup). Not yet done:

- PNG/ICNS/ICO rasters. No SVG rasterizer is installed. Generate them in the
  Tauri phase with `tauri icon`.
- An optical-weight review by a human designer.

## 3. Type

- **Sans**: Inter Variable, with Noto Sans Thai as fallback (Thai is a
  first-class script in fixtures and search). This is Notion's family. Grok's
  medium-weight, tight-tracking feel comes from the `display` token: 600
  weight, −0.035em.
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

- Content (blocks, menus, inputs) uses Notion radii: 4, 6, 8 and 12px.
- **Actions** (buttons, chips, context pills, CTA) use Grok pills (9999px).
- Feature cards and the marketing window use a 20px radius.
- Use hairline borders first (9% ink). Shadows are only for floating layers
  (popover, modal).

## 5. Where each influence applies

| Surface | Base theme | Notes |
|---|---|---|
| Marketing site, onboarding, import wizard | Night | Centred hero, muted lede, inverted white pill CTA, product window |
| Editor, sidebar, page views | Paper (light) by default; Night available | Notion layout: sidebar 260px, breadcrumbs, properties row, callouts |
| Agent Hub, agent side panel | Night in both themes | Chat bubbles, diff review, Apply/Discard pills, moon avatar |
| Transfer review (Private → Workspace) | Paper modal | Shows destination workspace and members before commit (spec §12) |

## 6. Accessibility

- Body text contrast: ink-primary on paper is about 17:1; on night it is about 18:1.
- Ink-tertiary (46%) is for meta text only, at 12px or larger.
- Moon on white is about 3.9:1, so it is not used for text. Use
  `--thoth-moon-ink` (`#8A3200`) for text on `moon-soft` instead.
- Focus rings use the moon colour, 2px, with a 2px offset.
- `prefers-reduced-motion` zeroes durations.

## 7. Open design questions

- Does the owner prefer the Moon Ibis or one of the alternative directions in
  `design/concepts/logo-directions-sheet.png`?
- Does the moon accent stay orange, or move to a cooler silver-blue that reads
  as "moon"? Orange was chosen for warmth next to Notion's paper.
- Do we license a custom display face later? For now, Inter is a deliberate,
  free choice for an OSS project.
