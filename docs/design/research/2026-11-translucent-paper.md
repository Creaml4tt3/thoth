# Thoth: subtle translucency and paper

Research: 2026-11-16, on branch `design/hooded-ibis-app`. Recommendations only; no application files changed by this research.

## Recommendation

Use native material behind navigation; retain a separate native title bar and keep the writing canvas opaque. Start with macOS **Sidebar** material and Windows 11 **Mica**. Tint the sidebar with `rgb(248 240 226 / .88)` in light mode and `rgb(23 21 20 / .90)` in dark mode. Add static grain behind content at **.025 light / .012 dark**. These alpha values are design starting points, not platform-prescribed constants. Preserve opaque web/Linux/accessibility fallbacks.

For this checkout's Tauri **2.12.5**, merge these exact fields into each existing window definition, per platform; preserve its size, label, drag/drop and zoom settings:

```json
{
  "transparent": true,
  "titleBarStyle": "Transparent",
  "hiddenTitle": true,
  "windowEffects": {
    "effects": ["sidebar"],
    "state": "followsWindowActiveState"
  }
}
```

The preceding block is macOS only. On Windows 11 use:

```json
{
  "transparent": true,
  "noRedirectionBitmap": true,
  "windowEffects": { "effects": ["mica"] }
}
```

Keep normal native decorations on Windows. On Linux leave `transparent: false` and omit `windowEffects`. Platform files are `tauri.macos.conf.json` and `tauri.windows.conf.json`; because merge-patch replaces arrays, copy the **complete** existing `app.windows` array into an override before adding these fields. These are window-property patches, not complete replacement config files. [Tauri config and merging](https://v2.tauri.app/reference/config/#platform-specific-configuration)

Do **not** add `app.macOSPrivateApi` for this locked version: it is a no-op since 2.12.1. For older Tauri 2 versions, transparency required `app.macOSPrivateApi: true` / the `macos-private-api` feature. Flag removal does **not** establish App Store compatibility; see the source audit below. [Release 2.12.1](https://v2.tauri.app/release/tauri/v2.12.1/)

CSS proposal, after existing rules. The asset names specify proposed assets, not files created by this research. Each is a **256×256 physical-pixel, seamlessly repeating, monochrome alpha-noise PNG**, displayed at **128×128 CSS pixels**; use black pigment for light and white pigment for dark. Set the new `data-os-effect` attribute on `html` only when the host has a supported, permitted native backdrop. Remove it on effect failure, user opt-out, or native reduced-transparency preference. Never infer availability merely from the presence of Tauri APIs. On failure or reduced transparency, also restore an opaque native window/title-bar background (`#FEFAF3` / `#0E0C0B`), or recreate an opaque window; CSS alone cannot fill a separate native title bar.

```css
:root {
  --thoth-sidebar-glass: rgb(248 240 226 / .88);
  --thoth-grain-image: url("/textures/grain-black-2x.png");
  --thoth-grain-alpha: .025;
}
html[data-theme="night"] {
  --thoth-sidebar-glass: rgb(23 21 20 / .90);
  --thoth-grain-image: url("/textures/grain-white-2x.png");
  --thoth-grain-alpha: .012;
}
@media (prefers-color-scheme: dark) {
  html[data-theme="system"] {
    --thoth-sidebar-glass: rgb(23 21 20 / .90);
    --thoth-grain-image: url("/textures/grain-white-2x.png");
    --thoth-grain-alpha: .012;
  }
}
html, body, #root, .shell { background: var(--thoth-bg); }
.sidebar { background: var(--thoth-bg-sidebar); }
.main {
  position: relative;
  isolation: isolate;
  background: var(--thoth-bg); /* #FEFAF3 / #0E0C0B, fully opaque */
}
html[data-os-effect],
html[data-os-effect] :is(body, #root, .shell) {
  background: transparent;
}
html[data-os-effect] .sidebar {
  background: var(--thoth-sidebar-glass);
  --thoth-ink-secondary: rgb(var(--thoth-ink) / .82);
  --thoth-ink-tertiary: rgb(var(--thoth-ink) / .78);
}
.main::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1; /* above this stacking context's background, below content */
  pointer-events: none;
  background-image: var(--thoth-grain-image);
  background-repeat: repeat;
  background-size: 128px 128px;
  opacity: var(--thoth-grain-alpha);
  mix-blend-mode: normal;
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  html[data-os-effect],
  html[data-os-effect] :is(body, #root, .shell) {
    background: var(--thoth-bg);
  }
  html[data-os-effect] .sidebar { background: var(--thoth-bg-sidebar); }
  .main::before { display: none; }
}
@media (forced-colors: active) {
  html, body, #root, .shell, .main,
  html[data-os-effect],
  html[data-os-effect] :is(body, #root, .shell, .sidebar) {
    background: Canvas;
    color: CanvasText;
  }
  .main::before { display: none; }
}
@media print { .main::before { display: none; } }
```

An opaque ancestor hides the native backdrop: changing `.sidebar` alone will not work because `body` and `.shell` currently paint solid backgrounds. `.main` must gain its own opaque fill when those ancestors become transparent. Keep the existing `.tabstrip` opaque initially; it is HTML content chrome, separate from the native title bar. A future translucent tab strip needs its own background layer arrangement, because the opaque `.main` behind it otherwise blocks OS material.

The stronger sidebar text is deliberate: simple sRGB compositing of the proposed light sidebar over pure black gives background approximately `(218,211,199)`. Existing `.64` tertiary ink then reaches only **4.38:1**; proposed `.78` reaches approximately **6.56:1** before row washes. This calculation is a design bound, not a screenshot measurement or complete accessibility certification. Recheck semantic colors, active/hover rows, controls and real material states; existing flat-token tests alone cannot certify the new surfaces.

## Evidence: what good apps actually demonstrate

The useful principle is **material for navigation/context, a stable surface for sustained reading**. Blur limits background detail; tint limits luminance changes. Reducing whole-window opacity also fades glyphs and controls and makes contrast depend on whatever is behind the app. Do not set CSS `opacity` on the shell or editor.

Apple distinguishes **behind-window** blending (desktop/other windows) from **within-window** blending (the app's own content). Its documented illustration uses behind-window blending for a sidebar and in-window blending for a title bar; toolbars use in-window blending. Its HIG separates glass navigation/controls from content and recommends semantic materials. The HIG's “prefer translucency” statement in its visionOS section is not a command to make a macOS editor transparent. [NSVisualEffectView](https://developer.apple.com/documentation/appkit/nsvisualeffectview) · [Apple HIG: materials](https://developer.apple.com/design/human-interface-guidelines/materials)

| App | Primary-source evidence and appropriate lesson |
| --- | --- |
| macOS Notes | Apple's guide shows separate sidebar, note list and plain note-content surfaces. Read the hierarchy as material chrome around a stable note, not proof of any particular alpha or private implementation. [Notes guide and first-party image](https://support.apple.com/guide/notes/view-your-notes-apd8b73d28be/mac) |
| Things 3 | Cultured Code explicitly describes subtle glass in the sidebar; its feature page describes the opened to-do as white paper. This is the closest reference for Thoth's restrained paper/chrome separation. [Mac release notes](https://culturedcode.com/things/support/articles/1100684/) · [Features](https://culturedcode.com/things/features/) |
| Arc | Arc documents Space themes in the sidebar and a Windows Acrylic transparency setting/fix. The styled browser frame is distinct from webpage content; these sources do not establish a universal material or alpha across versions/platforms. [Themes](https://start.arc.net/paint-the-internet) · [Windows release notes](https://resources.arc.net/hc/en-us/articles/22513842649623-Arc-for-Windows-2023-2026-Release-Notes) |
| Raycast | An important exception to “sidebar only”: a compact floating launcher can itself be translucent. Raycast documents transparent WebViews blending into native windows and Windows Acrylic integration. Its launcher/panels are a different use case from a full-window writing sheet. Do not assume every Raycast Notes/editor surface is opaque. [Engineering account](https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast) |
| Linear desktop | Linear explicitly shipped a configurable translucent macOS sidebar in 2022, and later offered a switch to disable translucent components for older-device performance. This is documented precedent, not a claim that every current theme/build retains that exact implementation. [Desktop release](https://linear.app/changelog/2022-03-15-new-desktop-app) · [Performance preference](https://linear.app/changelog/2022-10-19-2022-release) |
| Craft | Craft says it applies glass selectively where it improves clarity and focus. Treat navigation glass and document styling as separate decisions; the source does not establish that all document styles are literally opaque. [Craft's design explanation](https://www.craft.do/blog/craft-update-3-2-6) |
| Bear | Bear's OS26 announcement specifically discusses the refreshed toolbar and softer, blended sidebar. It supports restrained navigation/chrome treatment; it does not publish per-surface alpha or justify washing out note text. [Bear announcement](https://blog.bear.app/2025/09/bear-is-now-com-paw-tible-with-new-oses-with-adapted-glassy-look/) |

Closed-source product screenshots and release notes cannot establish which native APIs each app uses. CSS text inside a WebView also does not automatically acquire AppKit label vibrancy; custom palette contrast remains Thoth's responsibility. The specific recommendation that Thoth's editor remain fully opaque is an engineering/design judgment for a writing app, rather than an assertion about every listed application's pixels.

## Tauri 2 implementation, distribution and operating-system limits

- **Transparency is not blur.** `transparent: true` permits alpha in the WebView/window; `windowEffects` supplies platform-native material. CSS `backdrop-filter` alone cannot sample the desktop in the browser client. Tauri's effects require a transparent window and are unsupported on Linux. [Window configuration](https://v2.tauri.app/reference/config/#windowconfig)
- **macOS material:** `sidebar` maps to `NSVisualEffectMaterial::Sidebar`, which Apple defines specifically for window sidebars. Avoid deprecated appearance-based/light/dark materials and the crate README's HUD example for a navigation sidebar. Follow window active state rather than forcing “active.” [Apple Sidebar material](https://developer.apple.com/documentation/appkit/nsvisualeffectview/material-swift.enum/sidebar) · [Tauri 2.12.5 mapping](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/vibrancy/macos.rs#L84)
- **One backdrop, CSS masks:** the locked crate creates a visual-effect view covering native view bounds, inserts it below other content, and uses behind-window blending. Opaque HTML masks the writing area. This does not give the title bar a separate in-window-blending material; a fully native split-material implementation needs custom AppKit views. CSS clipping the visible effect also does not guarantee the OS avoids processing the obscured area. [window-vibrancy 0.8.1 implementation](https://github.com/tauri-apps/window-vibrancy/blob/74216857a010454ae4dd19618787f06b656747b3/src/macos/vibrancy.rs#L42)
- **Title bar:** `Transparent` retains a separate native title-bar area and reveals the window background; `Overlay` draws the native title bar over HTML. `Transparent` does not extend HTML or the crate's content-sized effect view under the separate title bar; do not promise a continuous blurred title bar from that setting alone. Use `Overlay` if that continuous material is required. It is optional for sidebar blur. If chosen, use `titleBarStyle: "Overlay"`, `hiddenTitle: true`, keep decorations, reserve traffic-light space and provide a real drag region; verify geometry on supported macOS releases and at zoom. The current capability file does not grant window dragging; an HTML `data-tauri-drag-region` requires narrowly adding `core:window:allow-start-dragging` (and any intended double-click action permission), or a host-owned alternative. `decorations: false` removes standard chrome and creates more work. [Tauri drag-region permissions](https://v2.tauri.app/learn/window-customization/#permissions) · [Current capabilities](apps/desktop/src-tauri/capabilities/main.json:11) · [Tauri title-bar modes and caveats](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri-utils/src/lib.rs#L166)
- **Windows 11:** prefer `mica` for this persistent window. Mica is an **opaque wallpaper-derived material**, not live see-through blur of other apps. It is designed to sample wallpaper once; its subtle personalization belongs especially in title bars/base layers. Thus Windows will feel material-rich without matching macOS translucency exactly. [Microsoft Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
- **Acrylic:** true background Acrylic can reveal desktop and other windows. Microsoft recommends background Acrylic for transient surfaces, in-app Acrylic for overlays, and an opaque background for persistent vertical panes. It explicitly identifies GPU/power costs and fallback states. For an experimental Windows live-blur variant use `"windowEffects": { "effects": ["acrylic"] }`, but it is not the recommendation for Thoth's fixed sidebar. [Microsoft Acrylic](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic)
- **Windows versions:** the locked crate uses `DWMWA_SYSTEMBACKDROP_TYPE` / `DWMSBT_MAINWINDOW` on newer builds and an undocumented Mica attribute on earlier Windows 11. Prefer testing/supporting Windows 11 22H2+ (22621+) for the documented DWM path. The crate's Acrylic/legacy blur resize/drag warnings are build-specific, not proof every modern Windows 11 configuration stutters. [Crate Windows source](https://github.com/tauri-apps/window-vibrancy/blob/74216857a010454ae4dd19618787f06b656747b3/src/windows.rs#L104) · [Crate support/performance table](https://github.com/tauri-apps/window-vibrancy#available-functions)
- **Config or crate, choose one owner.** Built-in `windowEffects` already uses window-vibrancy; no extra dependency is needed for that path. For reliable success/failure reporting and runtime accessibility control, add a direct dependency and use `apply_vibrancy(window, NSVisualEffectMaterial::Sidebar, None, None)` on macOS or `apply_mica(window, None)` on Windows, on the appropriate native thread. Omit config `windowEffects` when doing so; do not apply duplicate native backdrops. Clear effects on opt-out. Tauri 2.12.5's internal platform wrappers discard the underlying apply results, so a resolved built-in setter is not reliable evidence the material actually applied. [Tauri macOS wrapper](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/vibrancy/macos.rs) · [Windows wrapper](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/vibrancy/windows.rs) · [Crate API](https://docs.rs/window-vibrancy/0.8.1/window_vibrancy/)
- **Native theme:** keep the native window appearance synchronized with Thoth's resolved Light/Dark/System theme. Otherwise a light native material can show under dark CSS. Prefer semantic Sidebar plus the native theme over deprecated hard-coded dark materials. Windows `mica` follows system appearance; resolve a deliberate app/system mismatch through native appearance/effect handling and verify it. [Tauri effect variants](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri-utils/src/lib.rs#L122)
- **App Store:** `NSVisualEffectView` is public AppKit; blur itself is not forbidden. However, the locked Wry 0.57.1 transparency path still sets the private `drawsBackground` KVC key on WebView configuration; its runtime background-color path explicitly labels its instance key private. Removing the feature flag did not replace those calls with a public transparency API. Apple requires public APIs under guideline 2.5.1. Treat this transparency path as an App Store review risk, not a guaranteed rejection or guaranteed acceptance; use an opaque Store variant or establish a public-API implementation before promising Store support. A direct-download build and notarization are separate distribution questions. [Exact Wry transparency source](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/wkwebview/mod.rs#L413) · [Runtime private-key comment](https://github.com/tauri-apps/wry/blob/wry-v0.57.1/src/wkwebview/mod.rs#L1058) · [Apple 2.5.1](https://developer.apple.com/app-store/review/guidelines/#software-requirements)
- **Performance:** native materials add composition work; adding CSS blur on top is unnecessary. Measure idle GPU/energy, typing/scrolling, dragging/resizing and inactive windows on real machines. A Tauri issue reports significant idle recomposition with transparent macOS windows; it is a reporter's measurement, not a universal benchmark or a verified result on Thoth's pinned versions. Keep an opaque switch. [Reported Tauri issue](https://github.com/tauri-apps/tauri/issues/15471)
- **Linux/web:** ship the same opaque tokens and optional grain. Linux blur depends on the user's compositor and window-vibrancy does not implement it; a browser page has no desktop-backdrop effect. Do not enable transparent root styles there. [Crate platform support](https://github.com/tauri-apps/window-vibrancy#platform-specific)
- **Accessibility:** `prefers-reduced-transparency: reduce` requests fewer translucent effects. Support varies by embedded engine/OS, so CSS must not be the only gate. Bridge macOS `NSWorkspace.accessibilityDisplayShouldReduceTransparency` and changes; clear native effects and remove the attribute. Respect Windows transparency/high-contrast preferences and native solid fallbacks too. An opaque HTML layer hides the native effect but does not itself stop its rendering work. [CSS media-query spec](https://drafts.csswg.org/mediaqueries-5/#prefers-reduced-transparency) · [Apple native preference](https://developer.apple.com/documentation/appkit/nsworkspace/accessibilitydisplayshouldreducetransparency) · [Microsoft system backdrops](https://learn.microsoft.com/en-us/windows/apps/develop/ui/system-backdrops)

## Paper grain: restrained, static, behind content

- **Prefer a tiny tiled PNG.** Bake deterministic, seam-free monochrome grain once; reuse a single background layer. Normal alpha compositing of black pigment on paper and much fainter white pigment on dark ink avoids hue contamination and blend-mode surprises. Do not animate grain, generate it per render, apply filters to the editor DOM, or add `will-change` to a full-window surface. The PNG recommendation is a predictable-cost engineering choice, not a claim that every SVG necessarily rerenders every frame.
- **Strength:** start with 1–3% effective pigment opacity in light mode (recommend 2.5%), and 0.5–1.5% in dark (recommend 1.2%). Opacity means **the final pixel contribution**, including asset alpha and CSS opacity. Avoid a second faint asset multiplied by another faint alpha unintentionally; inspect at 100% and 200%. Dark-mode grain should be nearly imperceptible, without gray haze or bright speckles.
- **Blend modes:** `multiply` only darkens, making it useful with an opaque grayscale tile on light paper; `screen` only lightens and can work with an appropriately authored dark-mode tile. `overlay` / `soft-light` change local contrast and are harder to bound. Default to `normal` with pigment-alpha PNGs. Keep any blending in an isolated background layer so it cannot process text. [W3C compositing/blending definitions](https://www.w3.org/TR/compositing-1/#blending)
- **Layering:** the sample pseudo-element paints above opaque `.main` paper and below all writing/controls. Never place a positive-z-index texture overlay across glyphs. Grain beneath text can still alter its background luminance: it is acceptable only while actual worst-case contrast stays above the threshold. For zero risk to close-to-threshold text, leave the text column flat and texture margins only.
- **Contrast:** AA body text needs at least 4.5:1, large text 3:1; meaningful non-text controls also have contrast requirements. Test the most adverse texture pixels behind text, not average texture brightness. Extend Thoth's existing contrast checks to textured extremes and translucent/sidebar active states; disable texture for forced colors, increased contrast and reduced transparency. [W3C contrast guidance](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) · [Background-image failure F83](https://www.w3.org/WAI/WCAG21/Techniques/failures/F83)
- **High DPI:** keep a fixed logical tile size. The proposed 256-pixel tile at 128 CSS pixels is native resolution at 2×; add 1×/3× variants with `image-set()` if measurements justify them, keeping the same physical grain size in CSS. Do not use `cover`, stretch a tiny tile across a window, or scale up hard pixel noise. Check seams, aliasing and obvious repetition at fractional Windows display scales.
- **SVG alternative:** a small `data:image/svg+xml,...` background containing static `feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="7" stitchTiles="stitch"`, followed by desaturation, is compact, deterministic and convenient to tune. Percent-encode the SVG (including `#` as `%23`), define explicit image/filter bounds and repeat it as an image; do not attach `filter: url(...)` to the text container. `stitchTiles` addresses boundary continuity. A browser may cache the rasterized image; WebKit/WebView2 rasterization and scaling costs still need measurement. Never animate `seed` or frequency. [W3C feTurbulence](https://www.w3.org/TR/filter-effects-1/#feTurbulenceElement)
- **CSP:** the checked-in `img-src 'self' data: blob:` already permits a local PNG or SVG image data URI. This does not require broadening the policy. Prefer a packaged asset for reuse, caching and inspection. No evidence from the cited product announcements establishes which paper-texture algorithm any named app uses.

## Current repository findings

The requested literal scan was run across `apps/desktop/src-tauri/tauri.conf.json` and all `apps/desktop/src-tauri/src`, case-insensitively, for `transparent|vibran|effect|title.?bar|macosprivate|background_color|backgroundColor`. It returned **no matches**. Source/config findings:

- Main window: `main`, title `Thoth`, **1200×800**, minimum **720×480**, `dragDropEnabled: false`, `zoomHotkeysEnabled: true`. There is no `titleBarStyle`, `hiddenTitle`, `transparent`, `windowEffects` or `macOSPrivateApi`. Tauri defaults are a visible standard title bar, `transparent: false`, decorations enabled and no effects. **The title bar is not currently overlaid.** [Local config](apps/desktop/src-tauri/tauri.conf.json:12) · [Tauri defaults](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri-utils/src/config.rs#L2427)
- Additional `space-…` windows use `WebviewWindowBuilder::new`, then title/size/minimum size, drag/drop, zoom, focus and optional position. They also have no transparency/effect/title-bar customization. Configuring only the startup `main` window will leave these windows different; apply the same policy in their builder path. [Window creation](apps/desktop/src-tauri/src/lib.rs:540)
- Startup installs dialogs, notifications, updater, diagnostics and host state; the scan found no native vibrancy calls in Rust. [Startup](apps/desktop/src-tauri/src/lib.rs:801)
- The workspace specifies `tauri = { version = "2", features = [] }`; desktop inherits it and has no direct `window-vibrancy` dependency. The lock resolves **tauri 2.12.5**, **tauri-runtime-wry 2.12.3**, **tauri-utils 2.10.2**, **wry 0.57.1**, and transitive **window-vibrancy 0.8.1**. A transitive crate is present, but no effect is enabled by that fact. [Workspace dependency](Cargo.toml:48) · [Desktop dependencies](apps/desktop/src-tauri/Cargo.toml:16) · [Lockfile](Cargo.lock:3935)
- `body` paints `--thoth-bg`; `.shell` paints the same, `.sidebar` paints `--thoth-bg-sidebar`; `.main` currently has no fill of its own. `.tabstrip` paints sidebar color. These opaque ancestors currently prevent a semi-transparent sidebar from revealing an OS backdrop. [Body](packages/app-ui/src/ui.css:13) · [Shell/sidebar](packages/app-ui/src/shell.css:6) · [Main](packages/app-ui/src/shell.css:77) · [Tabs](packages/app-ui/src/shell.css:261)
- Tokens match the brief: light page **#FEFAF3**, sidebar **#F8F0E2**; dark page **#0E0C0B**, sidebar **#171514**. The theme attribute is `night`, not `dark`; `system` follows `prefers-color-scheme`. The CSS proposal handles both. [Tokens](packages/ui/src/tokens.css:32) · [Theme mapping](packages/app-ui/src/ui/theme.ts:19)
- Existing editor content scrolls in `.page-scroll`; contrast tests calculate flat token combinations, which must be expanded before claiming the material/texture variant passes WCAG. No implementation, runtime/GPU benchmark or new visual verification was performed for this research. [Editor](packages/app-ui/src/editor.css:118) · [Contrast checks](packages/app-ui/test/contrast.test.ts:1)
