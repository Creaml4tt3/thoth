# Awwwards "Mobile & Apps": references for the earth and paper directions

Collected 2026-11-11 from <https://www.awwwards.com/websites/mobile-apps/> (2,784 sites in the category that day).
The sites were opened in Chrome at 1440×900. Colours and fonts were read from computed styles (`getComputedStyle`), not
picked from the screenshots. Contrast ratios were computed with `docs/design/directions/palette.py`.

The hero screenshots are kept locally in `.tmp/awwwards/`, which git ignores. They are other companies' work, so they
stay out of this public repository. Take ideas from them, never assets or code.

## The nine sites

All nine showed "prefers-reduced-motion" rules in their CSS. "Unverified" means the script found a colour, but I could not
confirm what it is used for.

| Site | Award | Surfaces | Text | Accent | Display / body |
|---|---|---|---|---|---|
| [GoShuin](https://aestudio.studio/goshuin/en) | Nominee | paper `#F9F7F2`, `#E7E5DF`, `#F9F4E6`, `#EEE9DC` | `#292824` | stamp red `#C63730` (unverified role), indigo panel | Georgia / Hiragino Mincho, 400 / system sans |
| [Wispr Flow](https://wisprflow.ai) | Honorable Mention | cream `#FFFFEB`, `#E4E4D0`, ink `#1A1A1A` band | `#1A1A1A` | lilac CTA `#F0D7FF`, deep green `#034F46`, `#FFA946`, `#FF6C4C` | EB Garamond 400 (roman + italic) / Figtree |
| [Two-Do](https://twodo.design) | Nominee | warm near-black `#1B1815`, `#0C0B0A`, white 4% glass | `#F1ECE3` / `#B3AA9A` | gold `#E8BE6C`, sage | Fraunces 300 / Manrope |
| [Hozon](https://aestudio.studio/hozon) | Nominee | white, `#E9EDDF`, `#EEF0E5`, `#F4F0E8` | `#20221C` | olive `#4B603C` | Arial 900 at 324px / Arial |
| [The Way](https://www.thewayapp.com) | Nominee | painted off-white `#C5C2BB` texture | `#1C5349` | one deep green does everything | Nunito 500 / Nunito |
| [YumLog](https://yumlog.dev) | Nominee | rust `#A53A26` hero, navy `#1D1B2C` | `#FFFFFF` | coral `#F2533A` | SF Pro Rounded 900 / system |
| [Sparkle](https://sparkle.ankatms.com) | Nominee | `#FBFAF6` with yellow and violet washes | `#1C1736` | violet `#6B4FF0`, gold gradient words | system 820 + italic serif words |
| [Cooldock](https://cooldock.app) | Honorable Mention | `#EDECEB` into a misty green landscape | `#000000` | almost none; blue on widgets | Inter Display 700 |
| [Guidely](https://useguidely.co) | Nominee | white, peach `#FFF5ED`, `#FFDCA7` | `#14110D` | acid yellow `#FFF747`, pink `#F81C4D` | Geist 700 / Inter |

### What each shows

- **GoShuin (paper).** The site is laid out as a book. Pages sit on warm paper, a thin rule frames the content, and the
  footer works as a page turner ("Page 01 / 14 · Every Stamp, A Memory", Previous / Next).
  - The type is a big serif wordmark. Patterned washi art is shown in a framed panel, never behind the text.
  - Vermilion on paper is 4.9:1, a stamp red that is also AA for text.
  - It has an explicit **Pause motion** button.
- **Wispr Flow (paper, with personality).** A cream page and a classic serif headline with an italic second line ("Don't
  type, / *just speak.*").
  - The product's own content is used as decoration: dictated sentences run along a curved path into a waveform.
  - The CTA is a pastel fill with an ink outline. Ink on cream is 17:1.
- **Two-Do (earth, dark).** A warm brown-black, not a neutral one. Cream text is 15:1 and the muted body is 7.7:1.
  - Fraunces Light mixes roman and italic, with each word tinted gold or sage ("The to-*do* list built for *two.*").
  - The hero is a **live, clickable app prototype** instead of a screenshot, with a note: "Live prototype · tap anything".
  - The agent appears as a section of its own: "Agent is on it".
- **Hozon (earth, light).** Olive on cream, with oversized letters that the product photo passes through. The colour is
  almost absent; the type and one object carry the page.
- **The Way.** A single deep green on a hand-painted texture, and one sentence per screen as you scroll ("Let your
  fingers go limp.").
  - Dots on the side show your progress through the scroll story.
- **YumLog.** A full rust hero with white text (6.5:1). It shows the real product on a phone and a watch, with example
  speech bubbles of what you can say.
- **Sparkle.** A colourful example done with restraint: a warm off-white, large ink type, and colour in only two italic
  words and the illustration.
- **Cooldock.** Almost no UI colour at all. One misty landscape photo carries the mood.
- **Guidely.** The loudest of the nine: an acid-yellow CTA and peach pill buttons for every demo. It is useful as a
  boundary for how far to go, not as a model.

## Patterns

1. **Warm off-white, never pure white or grey.** Paper backgrounds sit at about L* 96–98, with a slight yellow-red tint:
   `#F9F7F2`, `#FFFFEB`, `#FBFAF6`.
2. **The ink is tinted too.** Text is a warm or coloured near-black (`#292824`, `#1C1736`, `#20221C`, `#1C5349`) and
   reaches 13–17:1. No site here uses pure `#000` on paper, except Cooldock, which has almost no colour.
3. **One strong accent with a single job.** Stamp red, olive, deep green, gold. The second and third colours are quiet
   tints, not competing saturated colours.
4. **Serif display with an italic turn.** GoShuin, Wispr and Two-Do each pair a serif display face with a plain sans,
   and use italic for the emotional second line. This supports D's Newsreader and E's Fraunces.
5. **Show the real product.** The best heroes show the app itself: Two-Do's live prototype, YumLog's phone and watch,
   GoShuin's book. Stock mood images alone (Guidely) read as generic.
6. **Use the product's own content as decoration.** Wispr's flowing sentences, Two-Do's agent section, The Way's
   one-line instructions. For Thoth that means real Markdown, pages and agent proposals.
7. **Texture is subtle and kept apart from text.** GoShuin's washi stays inside a framed panel, and The Way's paint is
   very low contrast. Text never sits on busy texture.
8. **Dark mode is warm.** Two-Do's `#1B1815` has a brown base with cream text. This matches E's umber dark mode.
9. **Book and page language.** GoShuin's page turner and The Way's scroll dots give a long story a shape you can follow.
   That fits a scribe's notes app.

## Takeaways for Thoth

1. **D Papyrus:** move the page from white toward GoShuin's paper. Today's light page is `#FEFAF3` (L* about 98.5),
   which fits. Keep the ink warm.
2. **D and E:** keep Moon orange as the one strong accent. Egyptian blue, papyrus green, malachite and ochre become
   quieter role colours, as in pattern 3. The tonal containers already do this.
3. **Hero type:** set the headline in the display serif with an italic second line, for example "Your notes.
   *Your files.*" Use one change of style, not a different colour per word: a single coloured word reads as a template
   tell.
4. **Hero product:** show the real editor. Use the mockup's editor (a page, the sidebar and an agent proposal) in a
   paper frame, in place of abstract shapes. Later, the site could embed a small live demo, as Two-Do does.
5. **Agent proposals:** treat them as the "agent is on it" moment: their own card in the Moon container, with Apply and
   Discard.
6. **Texture:** at most a faint ruled or paper texture on hero backgrounds, never behind body text. Never put it in the
   app's writing surface.
7. **E dark mode:** follow Two-Do. Umber near-black with cream ink at 15:1 or more, and gold (ochre) as the highlight.
8. **Site:** consider GoShuin's page language for long pages: "Page 2 of 6" and a Previous / Next footer. That is for
   the Head of Marketing to decide.
9. **Motion:** borrow GoShuin's explicit Pause motion button for any looping hero animation, on top of honouring
   `prefers-reduced-motion`.
10. **Avoid:** Guidely-level acid colours and stock mood photos. They would fight the calm writing surface the research
    and the owner both want.
