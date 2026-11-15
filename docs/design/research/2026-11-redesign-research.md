# Redesign research: colour, type and brand (November 2026)

Research for the Thoth redesign: richer, more colourful, a stronger brand, with Moon orange (`#E8590C`) still the anchor.
Written 2026-11-11. Every claim cites its source. Live sites were read in a real browser on 2026-11-11: the computed
fonts and colours of `body`, `h1` and `h2`, plus the background colours that cover the most area. Pages change, so
treat the hex values as samples from that day, not as brand specs. Anything not checked against a source is marked
**(from memory/unverified)**.

Where Thoth is today (from `packages/ui/src/tokens.css` and `design/DESIGN.md`): paper `#FFFFFF`, sidebar `#F9F9F8`, a
warm-black ink ramp built from opacity, Moon `#E8590C`, an AA accent shade `#C2410C`, eight text colours that pass AA
(gray, brown, orange, yellow, green, blue, purple, red), Inter Variable with Noto Sans Thai, and Newsreader as the serif.

---

## 1. Material colour systems

### 1.1 Material 2: "The color system"

Source: https://m2.material.io/design/color/the-color-system.html (a JavaScript-rendered page, read in a browser).

- **The model.** "you select a primary and a secondary color to represent your brand. Dark and light variants of each
  color can then be applied to your UI in different ways."
- **Three principles.** *Hierarchical*: "Important elements should stand out the most". *Legible*: text and icons on
  coloured backgrounds must meet legibility standards. *Expressive*: "Show brand colors at memorable moments that
  reinforce your brand's style."
- **Primary** is "the color displayed most frequently across your app's screens and components". Its light and dark
  variants separate neighbouring elements, for example a top app bar from the system bar, or a FAB icon from its
  container.
- **Secondary** "is optional, and should be applied sparingly to accent select parts of your UI". It suits FABs,
  sliders and switches, selected text, progress bars, and "Links and headlines".
- **Surface, background and error** "typically don't represent brand". The baseline background and surface are
  `#FFFFFF` and the baseline error is `#B00020`.
- **"On" colours** are for text, icons and strokes drawn on top of primary, secondary, surface, background or error.
  The defaults are `#FFFFFF` and `#000000`. This is the origin of Thoth's `--thoth-on-accent`.
- **Alternative colours** give different sections their own themes. In the Owl study, yellow is used for onboarding,
  blue for the personal account and pink for courses, "allowing users to better locate themselves within it". Material
  warns they "should be used cautiously, because they can be challenging to implement cohesively".
- **Additional colours for data.** In the Rally study, five extra colours mark sections: green for Accounts, orange and
  yellow for Bills, purple and blue for Budget. They are "still a part of your full color palette".
- **Tonal palettes (2014).** Each hue has ten steps, 50 to 900, plus accents A100, A200, A400 and A700. The page shows
  white or black check marks for which text colour is legible on each swatch. Two oranges that sit near Moon:
  - Orange: 50 `#FFF3E0`, 100 `#FFE0B2`, 200 `#FFCC80`, 300 `#FFB74D`, 400 `#FFA726`, 500 `#FF9800`, 600 `#FB8C00`,
    700 `#F57C00`, 800 `#EF6C00`, 900 `#E65100`
  - Deep Orange: 50 `#FBE9E7`, 100 `#FFCCBC`, 200 `#FFAB91`, 300 `#FF8A65`, 400 `#FF7043`, 500 `#FF5722`,
    600 `#F4511E`, 700 `#E64A19`, 800 `#D84315`, 900 `#BF360C`. Moon `#E8590C` sits between Deep Orange 600 and 700.
- **Palette generator.** It adjusts "Hue, chroma, and lightness" by algorithm and can build analogous, complementary or
  triadic palettes from one primary colour.

### 1.2 Material 2: dark theme

Source: https://m2.material.io/design/color/dark-theme.html

- "Use dark grey – rather than black". "The recommended dark theme surface color is `#121212`."
- "Apply limited color accents in dark theme UIs, so the majority of space is dedicated to dark surfaces."
- **Contrast.** "Dark surfaces and 100% white body text have a contrast level of at least 15.8:1", so text still passes
  4.5:1 on the lightest elevated surface.
- **Desaturation.** "A dark theme should avoid using saturated colors … Saturated colors also produce optical
  vibrations against a dark background". The baseline dark theme uses "the 200 tone of the primary color".
- **Elevation.** Higher surfaces get lighter through a white overlay: 1dp 5%, 2dp 7%, 4dp 9%, 8dp 12%, 24dp 16%. Material
  says not to use "light glows in place of dark shadows".
- **Branded dark surfaces.** "overlay the primary brand color at a low opacity over … `#121212`". For example, 8%
  primary over `#121212` gives `#1F1B24`. This is the recipe for a Night surface tinted with Moon.

### 1.3 Material 3: HCT and tone-based contrast

Source: https://m3.material.io/styles/color/system/how-the-system-works

- **One source colour gives five key colours:** "Primary, Secondary, Tertiary, Neutral, Neutral variant". Each key
  colour becomes a tonal palette with tones "from 0 to 100 in increments of 10, as well as 95, 98, and 99". The palette
  tones are then assigned to 26 colour roles, the same set for light and dark.
- **Example mapping.** "the algorithm assigns the color tone primary40 to the primary role and the tone primary100 to
  the on primary role." Surfaces come from the neutral palette.
- **HCT** stands for Hue (0–360), Chroma (0 up to about 120) and Tone (0 is black, 100 is white). Unlike HSL, it "allows
  the manipulation of a color's hue and chroma without affecting its tone." Tone sets contrast: "Colors with a greater
  difference in tone create higher contrast".
- **Contrast follows the tone gap.** Tones 50 and 98 for a button and its label give 3:1. Tones 30 and 98 give 7:1.
  Medium contrast mode guarantees 3:1, high contrast 7:1. Use "primary container and on primary container" roles for
  custom components so they work at every contrast level.
- **Chroma depends on hue and tone.** "some hues cannot exist with certain chroma or tones"; bright light blue and red
  are not possible. Practical consequence: an orange ramp has to lose chroma at its very light and very dark ends.

### 1.4 The same idea from Stripe and Linear

- **Stripe** moved its palette to CIELAB so that every hue follows one shared lightness curve and "has the same contrast
  value at a given level". Their rule: colours are "guaranteed to have sufficient contrast for small text if they are
  at least five levels apart, and at least four levels apart for icons and large text." They kept the hues vibrant by
  watching how colourful each one looked, not only its contrast.
  https://stripe.com/blog/accessible-color-systems
- **Linear** generates each theme from three inputs, "base color, accent color, and contrast", instead of 98 variables.
  The work is done in LCH because "a red and a yellow color with lightness 50 will appear roughly equally light". The
  contrast input enables "super high-contrast themes". https://linear.app/now/how-we-redesigned-the-linear-ui
- **Obsidian 1.13** mixes colours in OKLCH, for example `color-mix(in oklch, var(--color-red) 20%, transparent)`.
  https://docs.obsidian.md/Reference/CSS+variables/Foundations/Colors

**What this means for Thoth:** build every ramp, Moon and the category hues alike, on one perceptual lightness scale
(OKLCH, which CSS supports natively). Then "tone 40 on tone 95" passes for every hue, and contrast pairs are chosen by
step distance instead of being tested one at a time.

---

## 2. Note, writing and productivity apps

### Notion

- **Site:** body `#FFFFFF` with warm off-white bands `#F9F9F8` and `#F6F5F4`. Text is `rgba(0,0,0,0.95)` stepping down to
  0.54 alpha. Fonts are NotionInter and Inter. The h1 is 96px/600 with −4.6px tracking (very tight display type). Colour
  comes in as saturated blocks of blue `#097FE8`, yellow `#FFB110` and red `#F64932`, plus darker shades of each.
  Checked live at https://www.notion.com on 2026-11-11.
- **Site tokens:** a "tatami" scale runs 100–900 per hue, for example `--tatami-color-orange-500: #ff6d00`,
  `-600: #dd5b00`, `-700: #ab4a00`, and `--tatami-color-red-500: #f64932`. Same source.
- **Product:** three page fonts, "Default, Serif, or Mono", and "Small text" for density. Colour reaches content through
  text colour or block background, with `/red` style commands and a shortcut to reapply the last colour. Page icons and
  covers carry most of the personality. https://www.notion.com/help/customize-and-style-your-content
- The ten in-app colour names (Default, Gray, Brown, Orange, Yellow, Green, Blue, Purple, Pink, Red), each with a text
  and a background variant **(from memory/unverified; the help page only says "many colors")**. Thoth's eight text
  colours already follow this set.

### Linear

- **Redesign aims:** "a more neutral and timeless appearance" by "limiting how much chrome (blue in our case) was used".
  Higher contrast overall. The "inverted L-shape" chrome (sidebar plus header) was tuned "to reduce visual noise".
  "We started using Inter Display to add more expression to our headings", with regular Inter everywhere else.
  https://linear.app/now/how-we-redesigned-the-linear-ui
- **Site:** near-black `#08090A` with surfaces at `#0F1011`, `#101112` and `#161718` (steps of 1–2%). Inter Variable.
  The h1 is 64px at the in-between weight 510 with −1.4px tracking. The h2 is 48px in muted grey `#8A8F98`, so
  hierarchy comes from colour as well as size. Colour appears only in small pieces: pink `#F79CE0`, peach `#F7BF8B` and
  yellow `#FFDF9F` text inside product mockups, and soft radial gradients at 4% white. Status tokens are
  `--color-orange: #fc7840`, `--color-blue: #4ea7fc` and `--color-green: #27a644`. Checked live at https://linear.app on
  2026-11-11.

### Arc

- Each Space gets its own theme: "Pick a color or a gradient to match the vibe of each of your Spaces." It opens from
  the brush icon next to the Space name, or ⌘T → "Edit Theme". https://start.arc.net/paint-the-internet
- Gradients take up to three colours chosen from a constrained picker, and the background can have noise or grain
  **(from secondary reviews and search snippets, not verified first-hand)**.
- The lesson is that colour works as **wayfinding**: the whole sidebar tint tells you which context you are in.
- **Caveat:** Arc is shutting down. "Arc is sunsetting on December 22, 2026" (https://arc.net). Its ideas live on in Dia.
  Cite the pattern, not the product.

### Raycast

- **Site:** dark only. Body `#07080A`, Inter at weight 600 for the 64px h1. Text is white stepping down to 60%, 40% and
  30% alpha. Status colour tokens come in pairs, a solid and a 15% wash: `--color-red: #ff6161` with `#ff616126`, blue
  `#57c1ff`, green `#59d499`. Hero glows are radial gradients at 8–11% alpha (pink to lavender), over a dot-grid
  pattern. Checked live at https://www.raycast.com on 2026-11-11.
- **Wallpapers as brand.** The gradients started as placeholder backgrounds behind app mockups in Figma and became a
  shared wallpaper set. Their method: one angular gradient with up to seven stops of "tones that are similar, or follow
  one another on the color spectrum", an 800px layer blur, and a dark-purple base underneath.
  https://www.raycast.com/blog/making-a-raycast-wallpaper
- The pattern is a calm achromatic UI with colour pushed into atmosphere (backgrounds, glows, wallpapers) and status.

### Craft

- **Site:** warm paper body `#FCF9F7` and near-black ink `#030302`. Untitled Serif at weight 400 for headings (66px, −2px
  tracking) and Untitled Sans for body text, so the serif display face is the personality. Colour comes from large
  pastel blocks: periwinkle `#B8CAF5`, mint `#9BD8A9`, butter `#FDE99B`, and a sky gradient (`#9ED4EF` to `#D1EEF9`)
  blended `in oklab`. One muted teal accent token, `--accent: #427e8a`. Checked live at https://www.craft.do on
  2026-11-11.
- This is the closest match to "Ink & Moon made richer": warm paper, ink, an editorial serif, and colour on surfaces
  rather than on text.

### Things 3

- Reviewers note "bold fonts, lovely icons, and thoughtful splashes of color" and that the app "is dominated by white
  space". The sidebar puts areas in bold with their projects "in a lighter font". Each project shows a completion
  indicator. https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/
- Each sidebar list has its own icon colour (yellow star for Today, red calendar for Upcoming, blue for Inbox, and so on)
  **(from memory/unverified)**. It is the classic example of colour in icons only, with neutral rows.
- **Site:** system UI font, cool grey `#F2F5F7` with white cards, one blue `#4F91FB`. Checked live at
  https://culturedcode.com/things/ on 2026-11-11.

### Obsidian

- **Product tokens:** a neutral base ramp `--color-base-00` to `-100` (inverted in dark mode). One accent built from
  `--accent-h/s/l` that users can change in Settings → Appearance. An extended palette of eight hues (red, orange,
  yellow, green, cyan, blue, purple, pink), each with separate light and dark values (light orange `#ec7500`, dark
  orange `#e9973f`), "used for status messages, callouts, syntax highlighting, graph nodes and Canvas".
  https://docs.obsidian.md/Reference/CSS+variables/Foundations/Colors
- **Site:** dark greys from `#1F1F1F` to `#262626`, a system UI font stack, and a single violet `#A78BFA` used for text
  and buttons. Checked live at https://obsidian.md on 2026-11-11.
- The lesson is one user-changeable accent plus a fixed set of category hues that are tuned separately for each theme.

### Bear

- **Site:** custom "bearsans" and "bearsansheadline" fonts, text in `#444444` (soft rather than black), cool grey bands
  `#F3F5F7`, and one red accent `--accent-color: #DD4C4F`, with a lime highlight `#D3FFA4`. Checked live at
  https://bear.app on 2026-11-11.
- Bear ships many app themes, from light paper to deep dark, each keeping the red accent family
  **(from memory/unverified)**. A custom typeface carries a lot of its identity.

### Reflect

- **Site:** a deep violet-black `#030014` rather than neutral black. Display type is Aeonik Pro at weight 500, body is
  Inter. One violet accent `#9382FF` with soft violet radial glows at 6–8% alpha. Headline text uses a white-to-70%
  gradient. Checked live at https://reflect.app on 2026-11-11.
- The lesson is that **tinting the dark chrome with the brand hue** gives a strong identity cheaply, the same recipe as
  Material's `#121212` plus 8% primary.

---

## 3. Colourful brands done well

| Brand | What makes the colour rich but controlled | Source |
|---|---|---|
| **Stripe** | The base is white with navy text `#061B31` and slate `#50617A`. The colour lives in multi-stop radial gradients on cards (indigo `#486FFD`, violet `#C489FF`, pink `#FF90B9`, peach `#FFC977`, amber `#FFB451`), each card a different blend from the same family. Headings are Söhne at weight 300, which keeps loud colour feeling refined. One link colour, indigo `#533AFD`. The colour scales share one lightness curve. | live https://stripe.com 2026-11-11; https://stripe.com/blog/accessible-color-systems |
| **Raycast** | 98% neutral dark. Colour shows up as blurred gradient wallpapers, low-alpha glows, and solid-plus-15%-wash status pairs. Gradients use neighbouring hues, not opposite ones. | live site; https://www.raycast.com/blog/making-a-raycast-wallpaper |
| **Mailchimp** | "Cavendish Yellow is Mailchimp's hero color. We use Peppercorn for accents." One loud hero hue with a warm near-black (Peppercorn `#241C15` per secondary sources) instead of pure black. Big flat fields of yellow, never a gradient. | https://mailchimp.com/about/brand-assets/ ; hex from https://www.canny-creative.com/atlas/brand/mailchimp/ |
| **Duolingo** | One owned hue, Feather Green `#58CC02` ("when in doubt, lean in to green"), plus named secondaries (Macaw `#1CB0F6`, Cardinal `#FF4B4B`, Bee `#FFC800`, Fox `#FF9600`, Beetle `#CE82FF`) that each have a job: info, error, highlight and so on. The names make the palette memorable and the rules enforceable. | Official guidelines at design.duolingo.com now redirect to the blog. Values via https://www.canny-creative.com/atlas/brand/duolingo/ (secondary) |
| **Figma** | The marketing site is almost entirely black and white (figmaSans, figmaMono for labels) and lets product imagery and content carry the colour. The famous five-colour logo is enough on its own. | live https://www.figma.com 2026-11-11 |
| **Linear** | Neutral chrome. Colour only in status chips, labels and mockup highlights (pink, peach and yellow at high lightness). Hierarchy comes from muted grey secondary headings. | live https://linear.app; redesign post above |

Patterns that repeat across these brands:

1. **One owned hue** (yellow, green, orange) plus a disciplined near-black. Never several co-equal brand colours.
2. **Colour on large surfaces or atmosphere, neutral type.** Most text stays ink or white.
3. **Gradients only between neighbouring hues,** heavily blurred or at low alpha, and limited to hero or brand areas.
4. **Every extra hue has a named job** (Duolingo, Material's Rally study, Obsidian's extended palette).
5. **Light weights and big tight display type** let loud colour still read as premium (Stripe at 300, Linear at 510,
   Notion's −4.6px tracking).

---

## 4. Accessibility constraints (WCAG 2.2)

| SC | Level | Requirement | Source |
|---|---|---|---|
| 1.4.3 Contrast (Minimum) | AA | Text needs "a contrast ratio of at least 4.5:1". Large text needs 3:1, where large is "at least 18 point or 14 point bold", about 24px or 18.5px bold. Values are not rounded (4.499:1 fails). Logotypes are exempt. | https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html |
| 1.4.11 Non-text Contrast | AA | "at least 3:1 against adjacent color(s)" for anything "required to identify user interface components and states" and for "Parts of graphics required to understand the content". Inactive controls are exempt. State indicators such as selected or focused must reach 3:1. | https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html |
| 1.4.1 Use of Color | A | "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element." Inline links need 3:1 against the surrounding text plus another cue (technique G183). | https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html |
| 2.4.7 Focus Visible | AA | A visible focus indicator whenever a component has keyboard focus (as summarised on the 2.4.13 page). | https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html |
| 2.4.11 Focus Not Obscured (Minimum) | AA | "When a user interface component receives keyboard focus, the component is not entirely hidden due to author-created content." This matters for sticky headers, toasts and floating agent panels. | https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html |
| 2.4.13 Focus Appearance | AAA | The indicator must be at least the area of "a 2 CSS pixel thick perimeter" with "a contrast ratio of at least 3:1 between the same pixels in the focused and unfocused states". AAA, but a good target. | https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html |
| 2.3.3 Animation from Interactions | AAA | "Motion animation triggered by interaction can be disabled". The sufficient technique is C39: "Using the CSS prefers-reduced-motion query". | https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html |

**Moon checked against these rules** (WCAG relative-luminance formula, computed for this doc):

| Pair | Ratio | Passes |
|---|---|---|
| `#E8590C` text on white | 3.58:1 | Large text and UI (3:1) only. **Not body text.** |
| White text on `#E8590C` | 3.58:1 | Large or bold-large labels only |
| `#141210` ink on `#E8590C` | 5.22:1 | All text. Dark ink on a Moon fill is the stronger pair. |
| `#C2410C` (current `--thoth-accent`) on white | 5.18:1 | All text |
| `#E8590C` on `#121212` | 5.23:1 | All text on Night |
| `#FF8A4C` on `#121212` | 8.02:1 | A desaturated, lighter Moon for dark mode, as Material 2 advises |

Moon at full strength works as a **fill, a 3:1 indicator or a display-size colour**. For body-size text on paper, use
the darker shade, which Thoth already does with `#C2410C`.

---

## 5. Takeaways for Thoth

1. **Build every ramp on one perceptual tone scale.** Generate Moon and each category hue in OKLCH at matching
   lightness steps (for example 98, 95, 90, 80, 70, 60, 50, 40, 30, 20, 10), the way M3 uses HCT, Linear uses LCH and
   Stripe uses CIELAB. Then "step 40 text on step 95 surface" passes for every hue, and pairs can be chosen by step
   distance (Stripe: 5 steps apart for small text, 4 for icons and large text). Extend the existing contrast test to
   check whole ramps.
2. **Moon stays the only brand hue. Other colours are categories, not brand colours.** Following Material's
   "alternative colours" and Duolingo's named secondaries, add a fixed set of 8–10 **category hues** for tags, folders,
   Spaces and agents (Thoth already has eight text-colour names). Give each one a role and never use them for primary
   actions. Primary actions and focus stay Moon.
3. **Give each category hue three roles, not one.** A *wash* (step 95 to 90) for chips and row tints, a *solid* (step 60
   to 50) for dots, icons and graph nodes, and an *ink* (step 30 to 40) for text on the wash. Raycast's solid-plus-15%
   pairs and M3's container/on-container are the same idea.
4. **Colour Spaces and agents as wayfinding, like Arc and Owl.** Let each Space, and each agent in the Agent Hub, choose
   a category hue. Show it in the sidebar icon, a 2–4% tint on the sidebar or header, and the agent's avatar ring. The
   tint tells you where you are without colouring any text.
5. **Keep the writing surface calm.** Paper stays neutral and ink stays ink. Colour only enters content through what
   the user chooses (text and highlight colours, callouts, tags). Every product studied keeps the document canvas
   achromatic.
6. **Tint Night with Moon.** Material's recipe of `#121212` plus 8% primary, and Reflect's violet-black `#030014`, show
   that a near-black tinted with the brand hue reads as branded where plain grey reads as generic. Try Night with 3–6%
   Moon mixed in, and step elevated surfaces up with white overlays (5%, 7%, 9%, 12%), not glows.
7. **Desaturate and lighten Moon in dark mode.** Material uses the 200 tone of primary on dark surfaces because
   saturated colour "vibrate[s]". Use a lighter Moon (about `#FF8A4C`, 8:1 on `#121212`) for text and icons on Night.
   Keep full `#E8590C` for fills.
8. **Use gradients only for brand moments.** The site hero, onboarding, the sign-in page, empty states, the "agent is
   thinking" moment, and release or marketing art. Follow Raycast's method: neighbouring hues only (Moon, amber, rose,
   dusk violet), heavily blurred, at low alpha over Night. Never put a gradient behind body text or app controls.
9. **Moon at full strength is a fill or a large element, not body text.** At 3.58:1 on white it passes for UI parts and
   large text only (WCAG 1.4.3 and 1.4.11). For a Moon button with small text, use dark ink `#141210` on Moon (5.2:1)
   or keep the deeper `#C2410C` with white text (5.2:1).
10. **Every coloured signal needs a second cue (1.4.1).** Tag colour comes with the tag name, status colour with an
    icon or label, an agent's colour with its name or avatar, and the selected tree item with a shape or weight change.
    Focus rings must be at least 2px and 3:1 (aim for the 2.4.13 standard), and never hidden by sticky bars or the
    agent panel (2.4.11).
11. **Get personality from type and shape, not more colour.** Linear added Inter Display for headings, Craft uses an
    editorial serif, Notion uses −4.6px tracking. A richer display face plus Thoth's existing pill shapes adds
    character without adding noise. See section 6.
12. **Respect reduced motion.** Brand gradients may drift slowly, and the mascot may animate, but only under
    `@media (prefers-reduced-motion: no-preference)`. Otherwise show a static frame (C39).

---

## 6. Fonts that cover Thai (free, on Google Fonts)

Source for subsets, weights, axes and designers: the Google Fonts metadata API, https://fonts.google.com/metadata/fonts
(read 2026-11-11). Licence: every family below is in the `ofl/` directory of https://github.com/google/fonts, which means
the SIL Open Font License 1.1. This was checked in each `METADATA.pb` for Kanit, Anuphan, Instrument Serif and Google
Sans (`license: "OFL"`).

### Thai and Latin families (cover Thai)

| Family | Style | Weights / axes | Designer | Notes for Thoth |
|---|---|---|---|---|
| **Noto Sans Thai** (current) | Loopless sans | variable wght 100–900, wdth 62.5–100 | Google | Safe body face that matches Inter. Keep it as the Thai text face. |
| **Noto Sans Thai Looped** | Looped sans | variable wght 100–900, wdth 62.5–100 | Google | Traditional looped forms, more formal and easier for long reading. |
| **Noto Serif Thai** | Serif | variable wght 100–900, wdth 62.5–100 | Google | Thai partner for a Latin serif display face. Already the fallback for Newsreader. |
| **IBM Plex Sans Thai** (+ Looped) | Sans | static 100–700 | Mike Abbink, Bold Monday | A clear technical character. Pairs with IBM Plex Sans and Mono as a whole family. |
| **Anuphan** | Loopless sans | variable wght 100–700 | Cadson Demak | Modern and calm, and the only Cadson Demak family with a variable axis. Good Thai UI face. |
| **Bai Jamjuree** | Squarish sans | static 200–700 + italics | Cadson Demak | Geometric and techy, good for display. |
| **Sarabun** | Loopless sans | static 100–800 + italics | Suppakit Chalermlarp | A standard Thai government face. Neutral and very readable, not distinctive. |
| **Prompt** | Geometric loopless | static 100–900 + italics | Cadson Demak | Friendly and round. A popular Thai display and UI face. |
| **Kanit** | Condensed loopless | static 100–900 + italics | Cadson Demak | Strong, condensed and bold. The most "brand-y" Thai display face, and widely used. |
| **Chakra Petch** | Squared, techy | static 300–700 + italics | Cadson Demak | Sci-fi or gaming feel. Probably too cold for Thoth. |
| **Mitr** | Rounded loopless | static 200–700 | Cadson Demak | Soft and warm display face. |
| **Trirong** / **Taviraj** | Thai serifs | static 100–900 + italics | Cadson Demak | Editorial Thai serifs, an alternative to Noto Serif Thai for a serif display voice. |
| **Google Sans** | Sans | variable wght 400–700, GRAD, opsz | Google | OFL and covers Thai as of the 2025 Google Fonts release (`isBrandFont: false`). Strongly associated with Google, so avoid it for brand. |
| **Playpen Sans Thai** | Handwriting | variable wght 100–800 | TypeTogether, Sirin Gunkloy et al. | Possibly for the mascot or playful marketing only. |

### Latin display faces that pair (no Thai: Thai falls back to one of the faces above)

| Family | Weights / axes | Pairs with | Notes |
|---|---|---|---|
| **Inter** (with the opsz axis) | wght 100–900, opsz 14–32 | Noto Sans Thai, Anuphan | The Google Fonts Inter has an opsz axis whose large end is the "Display" cut. This is how Linear's "Inter Display" headings come for free without a new family. Lowest risk. |
| **Inter Tight** | wght 100–900 | same | A tighter Inter for big headings. |
| **Bricolage Grotesque** | wght 200–800, wdth 75–100, opsz 12–96 | Kanit, Prompt, Anuphan | A quirky grotesque with lots of character. "Not boring" without becoming a novelty. |
| **Fraunces** | wght 100–900, opsz 9–144, SOFT, WONK | Noto Serif Thai, Trirong | A soft, warm "old style" serif. The SOFT and WONK axes let a single family range from calm to playful. Fits "Ink & Moon". |
| **Instrument Serif** | 400 + italic only | Noto Serif Thai | Condensed editorial serif for headlines only, in the spirit of Craft's serif headings. Only one weight. |
| **Instrument Sans** | wght 400–700, wdth 75–100 | Anuphan | A clean companion sans if Instrument Serif is chosen. |

**Shortlist** (judgement, not from a source):

- **Low-risk app pairing:** Inter with the opsz axis for display headings, Noto Sans Thai for body, and Anuphan as a
  calmer Thai alternative to compare.
- **Richer brand pairing** (site and marketing): Fraunces or Bricolage Grotesque for Latin display, with Noto Serif Thai
  or Kanit respectively for Thai display. Test that the Thai glyphs feel the same weight at the same size, because Thai
  usually needs about 1.1× the size and a looser line height.

---

## Not covered or not verified

- Duolingo's official guidelines (design.duolingo.com) now redirect to the blog, so its hex values come from a
  secondary teardown. Mailchimp's hex values are also secondary. The roles ("hero", "accents") are first-party.
- Things 3 per-list icon colours, Notion's in-app colour names and Bear's theme list are from memory.
- Arc's grain and noise controls come from reviews only. The first-party page confirms colours and gradients per Space.
- No in-app screenshots were taken. All "live" observations are from marketing sites, not the products themselves.
