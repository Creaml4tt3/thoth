# Pinterest "Color combos with orange"

Collected 2026-11-11 from <https://www.pinterest.com/ideas/color-combos-with-orange/911605426702/>. A sign-in window
covered the middle column, and I didn't sign in, so I read the 40 pins in the visible columns. Every pin's alt text is just
"Pin", so the hex values below come from the labels printed on the pin images. Small labels may be misread.

The 12 most palette-like pins are kept locally in `.tmp/pinterest/`, which git ignores, because they're other people's
images. Contrast was computed with `docs/design/directions/palette.py`. "Paper" is direction D's page, `#FEFAF3`.

## Combinations that recur

| Family | Pins | Example values | Count |
|---|---|---|---|
| Orange + dusty or navy blue + cream | 4, 5, 10, 21, 25, 26, 32, 34, 39 | Blue Surf `#3B5B8A`, Blue `#4D6080`, Veil Blue `#93A4B7`, Riviera `#183451`, Cream `#E9D9CA`, Soft Ivory `#F3ECDE` | most common, by far |
| Orange + teal + sage + olive (botanical) | 9, 14, 20, 36 | deep teal `#0D4B66`, sage `#7BA68D`, olive `#2E3D1F`, cream `#F4E6C1` | common |
| Orange + browns + sand (earth) | 2, 12, 21, 33 | Espresso `#3E2723`, Terracotta `#A9501C`, Sand Linen `#D4AF83`, chocolate, beige | common |
| Orange + plum or violet | 1, 6, 16, 24, 28 | Plum `#7F1633`, `#46334F`, `#8082A6` | some |
| Orange + neon pink, or lime | 8, 13, 18 | Neon Pink `#F52380`, `#81B807` | a few; loud |
| Orange + black | 2, 33 | | a few |

## How the pins compare with the directions

| Pin colour | Hue | On paper | Nearest Thoth colour |
|---|---|---|---|
| Blue Surf `#3B5B8A` (pin 5) | 258 | 6.6:1 | **D's Egyptian blue `#3B5F8A`**, which is almost identical (hue 254, 6.3:1) |
| Blue `#4D6080` (pin 25) | 261 | 6.1:1 | D's Egyptian blue, slightly greyer |
| Riviera `#183451` (pin 21) | 251 | 12.2:1 | D's blue at about tone 20: a good dark-mode surface or deep accent |
| Deep teal `#0D4B66` (pin 14) | 233 | 9.1:1 | between A's lapis blue and E's malachite |
| Olive `#2E3D1F` / sage `#7BA68D` (pin 14) | 130 / 159 | 11.2 / 2.6:1 | D's papyrus green `#6F8A3C` (hue 126). Sage is fine for fills, not for text. |
| Espresso `#3E2723` (pin 12) | 30 | 13.3:1 | D and E's warm ink. This supports a brown-black ink over grey. |
| Terracotta `#A9501C` (pin 21) | 47 | 5.2:1 | the darker Moon shades in all directions (`#B64201`) |
| Plum `#7F1633` (pin 1) | 11 | 9.8:1 | none yet. It could be a sixth accent hue, or a deeper version of the red. |

## Takeaways for Thoth

1. **D Papyrus is in line with what people pin most:** orange, a dusty blue and cream. D's Egyptian blue matches the
   most-pinned blue almost exactly, and both pass AA on paper as text.
2. **The second most popular family is botanical:** teal, sage and olive. It supports D's papyrus green and E's
   malachite. Keep sage-like tints for fills (2.6:1), never for text.
3. **Pins use orange as the loudest colour and give it one or two quiet partners.** This matches the Awwwards finding
   (one strong accent with a job). Tints and containers carry the rest.
4. **Ink: use Espresso-like brown-black, not neutral black.** D already does.
5. **Navy as a deep anchor:** Riviera-like navy works as a dark surface or a heading colour next to orange. That suggests
   D's dark mode could lean blue-navy instead of brown. This is an option to show the owner, not a change.
6. **Avoid neon pink and lime with Moon.** They are popular in fashion pins, but they would fight the calm writing
   surface.

Not checked: the pins hidden behind the sign-in window; the source pages behind the pins (none of them link anywhere).
