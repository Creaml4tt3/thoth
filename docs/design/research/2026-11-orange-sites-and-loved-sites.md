# Orange-brand sites (Mobbin) and the owner's favourite sites (x.ai/bot, notion.com)

Collected 2026-11-11 in Chrome at 1440×900. Colours, fonts and sizes were read from computed styles. The screenshots are
kept locally in `.tmp/mobbin/` and `.tmp/loved/`, which git ignores, because they show other companies' work.

## The owner's favourites

The owner said they love <https://x.ai/bot> and <https://www.notion.com/>.

### x.ai/bot (the Grok Bot page)

**Measured:**
- Dark only: page `#0A0A0A`, white text.
- h1: 60px, weight 500, letter-spacing −0.6px.
- Pill buttons: the primary is white with dark text, the secondary `#202020`, radius 9999px.
- Fixed 64px nav, `rgba(10,10,10,.85)` with a 12px backdrop blur.
- Cards: radius 24px, mostly with no border.
- Has `prefers-reduced-motion` rules.

**What makes it distinctive:**
- **The mascot sits inside the headline as a glyph:** "Meet ◐ Grok Bot". Thoth's DESIGN.md already asks for "Meet ◐ Thoth".
- **A bare, centred hero:** an announcement pill, the h1, a grey subtitle and two pills, then a **real app window** that
  shows agents as a list with coloured avatars and their work as log lines ("Salesforce → list pulled · 52 accounts").
- **No glows or gradients.** Depth comes from steps of near-black grey (`#0A0A0A`, then `#1A1A1A`, then white at 6%).
- **The mascot appears again at huge scale, cropped by a card,** as a section illustration.
- The pacing goes: one big card, a 2×2 bento, a phone, video, pricing.
- **Restrained type:** weight 500 throughout, with tight tracking.

### notion.com

**Measured:**
- Light only: white page, `#F9F9F8` bands.
- h1: 96px, weight 600, letter-spacing −4.6px.
- Primary button blue `#0075DE`, secondary `#E6F3FE`, radius 8px.
- Cards: radius 12px, with 1px `rgba(0,0,0,.1)` borders and stacked shadows under 4% opacity.
- 18 reduced-motion rules; almost nothing animates.

**What makes it distinctive:**
- **A huge, tight headline with a pill word that cycles,** "Where teams and agents ● Build together", in a yellow pill
  with an orange dot.
- **Hand-drawn ink characters** sit on the edges of a faithful app window that lists agents in its sidebar.
- **Mostly monochrome.** Colour appears only in small icons and tags, and in one strong colour per testimonial portrait.

## Orange-brand sites (Mobbin)

Source: <https://mobbin.com/explore/sites/styles/orange-design>. The page showed about 25 cards before a sign-in prompt,
and I didn't sign in. The sites it listed: Replit, Cloudflare, Mistral AI, Harvest, Monarch, Dropbox, Overmind, Ada,
Readymag, PayPal, Canva, Udemy, Gumroad, Coda, Jitter, ElevenLabs, 1Password, Lemon Squeezy, Typeform, Mailchimp and
Duolingo. The eight below were measured; Zapier, Postman and Claude replace Opennote, which now shows an "acquired" page.

| Site | Orange | Surfaces | Text | Display / body | CTA |
|---|---|---|---|---|---|
| Replit | `#FF3C00` | `#F6F5F4`, `#FAF6F1` | `#37383C` | Replit Diatype 400 | orange fill, 8px corners |
| Cloudflare | `#FF5E1F` | `#151414`, orange hero panel | `#FFFBF5` | STK Bureau Sans 500 | cream pill |
| Mistral | `#FF5229` → `#FFAF01` steps | `#101013` | `#FAFAF4` | ALTMistral 500 | ghost, white at 5% |
| Harvest | `#FA5D00` | `#FBF5F0`, `#F3EBE4` | `#1D1E1C` | Besley serif 400 / Muoto | black pill |
| Zapier | `#FF4F00` | `#FFFEFB`, `#F8F4F0` | `#201515` | Degular Display 500 / Inter | orange fill, 4px corners |
| Postman | `#FF6C37`, CTA `#E0531F` | `#0E0704` | `#FFF0DE` | gtStandard 500 / Inter | orange fill |
| Claude | `#C6613F` | `#141413`, `#30302E` | `#FAF9F5` | serif 400 | cream fill |
| Monarch | `#FF692D` | `#F6F5F3` | `#22201D` | Copernicus serif 350 | orange pill |

### Patterns

1. **No pure white in light mode.** Every light site uses a warm off-white. That supports Papyrus paper.
2. **Dark sites use warm near-blacks** (`#151414`, `#141413`, `#0E0704`). None is blue. **Papyrus Midnight's navy
   `#030F1D` would set Thoth apart in this set** instead of blending in.
3. **Orange stays on one element:** the CTA or the logo. Only Cloudflare floods a whole section with it.
4. **Headlines are never orange.** They are ink or cream at weight 400–500, and 3 of the 8 use a serif.
5. **Text is never pure `#000` or `#FFF`;** it is always tinted.

## Takeaways for Thoth (Papyrus Midnight)

Built into `docs/design/directions/midnight-site.html`. Every pair passes AA.

1. **The hero:** "Meet ◐ Thoth" with the Moon Ibis as a glyph in the headline (Grok bot), centred and bare, with an
   announcement pill and pill CTAs at weight 500.
2. **The real app window** comes after the CTAs, showing agent log lines and a proposal waiting for review. This is what
   Thoth does, said the way Grok bot says it.
3. **Depth in Midnight comes from tonal steps of the navy,** not glows. The paper version uses Notion's very soft
   stacked shadows.
4. **The mark at large scale, cropped by a card** (Grok's mascot move), in Moon orange.
5. **A pill word that cycles** (Notion), in Moon's container with an orange dot, through agent verbs: "ask first",
   "tidy folders", "draft pages", "remember". It cycles only when the visitor allows motion.
6. **Orange stays on the CTA, the mark and agent moments.** Headlines stay ink or cream (Mobbin pattern 4).
7. **Not borrowed:** Notion's blue buttons, which would compete with Moon. Notion's hand-drawn characters wait for the
   mascot decision, which the owner hasn't made yet.

## How the Grok Bot mascot moves (checked 2026-11-11)

Cloudflare blocked the live x.ai/bot for automated browsers (403), so this comes from the Wayback Machine copy of
2026-11-04. Frames are in `.tmp/motion/`, which git ignores.

- **The named CSS animations move the demo chat, not the mascot.**
  - Message rows enter with opacity 0→1 and `translateY(8px) scale(.97)` → none, over 280–420 ms, with
    `cubic-bezier(.2,.9,.3,1.15)`, a small overshoot.
  - The demo window fades in over 1 s.
  - A 12px spinner loops.
- **The mascot is an SVG redrawn by script every frame.**
  - Its eyes glance to a new spot (about ±10% of its size) and hold for 1–3 s.
  - It blinks every 2–4 s, taking about 200 ms.
  - It changes expression between dots, happy curves and tall ovals.
  - Its eyes follow the pointer within about 600 ms.
  - Hovering its card scales the face up about 7% over about 0.5 s. It never rotates or changes colour.
- **Reduced motion:** the CSS entrances turn off, but the spinner and a pulse keep running. Whether the scripted eyes stop
  could not be checked.

**A spec for the Moon Ibis mark, kept as a proposal.** The ibis eye is the "eye" here, so it fits the mark.
- **Entry:** opacity with `translateY(8px) scale(.97)` → none, 420 ms, `cubic-bezier(.2,.9,.3,1.15)`, played once.
- **Idle:** the eye blinks (scaleY 1→0.15→1) over 180 ms every 2.5–5 s at random. The head glances ±2–3px every 2–4 s,
  over 400 ms, with `cubic-bezier(.22,1,.36,1)`.
- **Reaction:** on hover, scale up 6% over 350 ms. The eye may follow the pointer, by ±3px at most.
- **Reduced motion:** no entry movement, no idle loop and no pointer tracking. Unlike Grok, no endless spinner.

## Each site's own dark mode

| Site | Dark mode | Dark page | Text | Accent in dark | Tone |
|---|---|---|---|---|---|
| Notion, Replit, Zapier, Harvest, Monarch | none | (light only) | | | |
| Claude | follows the system | `#141413` | `#FAF9F5` | `#C46849`, deeper than the light `#D97757` | warm |
| Postman | dark hero always | about `#291007` | `#FFF0DE` | `#E0531F` | warm brown |
| Cloudflare | follows the system | `#151414` | `#FFFBF5` | `#FF5E1F`, unchanged | warm-neutral |
| Mistral | follows the system | `#101013` | `#FAFAF4` | `#FF5229`, unchanged | neutral |
| x.ai/bot | follows the system (light exists) | `#0A0A0A` | white | white and black buttons | neutral |
| Linear | dark only | `#08090A` | `#F7F8F8` | `#5E6AD2` | slightly cool |
| Raycast | dark only | `#07080A` | `#FFFFFF` | `#FF6363` | slightly cool |

**Patterns:**
- **Most orange brands have no dark mode at all.**
- **The ones that do use a warm near-black.** None offers its own light/dark switch; the system setting decides.
- **Claude deepens its orange in dark mode so it doesn't glow.** Papyrus Midnight's site test does the same with
  `#E8590C`.
- **`#030F1D` would be the only true navy in this set,** and the only one pairing orange with its cool complement.
