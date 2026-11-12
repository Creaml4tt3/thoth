# Redesign directions (2026-11-11)

Five colour directions around Moon orange (D and E are the earth and paper tones the owner asked for on 2026-11-11), for the owner to choose from. Research: `../research/2026-11-redesign-research.md`.

- `palette.py`: Material-style tonal palettes (tone 0–100 = CIE L*, hue and chroma from OKLCH), the light and dark roles,
  and the WCAG check of every text/background pair. `python3 palette.py` prints pass or fail per direction and theme.
- `build.py`: writes `lapis.html`, `faience.html`, `dusk.html`, `papyrus.html`, `earth.html`, `navy.html` (D with a navy dark mode), `midnight.html` (D with a near-black navy) (self-contained; Google Fonts for the preview only).
  The build fails if any pair is below AA.

- `blueblack.html`, `blueblack-site.html`, `blueblack-layout.html` (2026-11-12): D with the owner's `#00001C` dark page and sans headlines;
  `layout.py` writes the layout page: inset page card, Ask beside the page, a composer-first Home, a three-column Agent Hub,
  split sign-in, and a phone bottom bar.

Status: proposed, not chosen. Nothing in the app uses these yet.
