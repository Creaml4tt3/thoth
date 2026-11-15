import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** WCAG AA for the Papyrus Black roles (ADR-0053) and the accent roles of Phase 3b AC 2, computed from the real token CSS in every theme. */
const css = readFileSync(new URL("../../ui/src/tokens.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector line starts with `selector`. */
function block(source: string, selector: string): Record<string, string> {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const m of source.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const light = block(css, ":root {");
const night = { ...light, ...block(css, '[data-theme="night"][data-theme]') };
const systemDark = { ...light, ...block(css.slice(css.indexOf("@media (prefers-color-scheme: dark)")), '[data-theme="system"][data-theme]') };

type Rgb = [number, number, number];
interface Colour { rgb: Rgb; alpha: number }

function parse(value: string): Colour {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const fn = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(value);
  if (fn) return { rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])], alpha: fn[4] === undefined ? 1 : Number(fn[4]) };
  throw new Error(`cannot parse colour ${value}`);
}

/** The colour as seen on an opaque backdrop. */
const over = (top: Colour, back: Rgb): Rgb => top.rgb.map((c, i) => Math.round(c * top.alpha + back[i]! * (1 - top.alpha))) as Rgb;

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_COLOURS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "red"];

const themes = { light, dark: night, "system (dark OS)": systemDark };

describe.each(Object.entries(themes))("accent contrast, %s theme", (_name, t) => {
  const token = (name: string): Colour => parse(t[name] ?? (() => { throw new Error(`missing ${name}`); })());
  const bg = (name: string): Rgb => token(name).rgb;
  const accent = bg("--thoth-accent");
  const surfaces = ["--thoth-bg", "--thoth-bg-sidebar"];

  it("text on the accent (primary buttons) is at least 4.5:1", () => {
    expect(ratio(bg("--thoth-on-accent"), accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(surfaces)("accent links on %s are at least 4.5:1", (surface) => {
    expect(ratio(accent, bg(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(surfaces)("selected item text on the accent wash over %s is at least 4.5:1", (surface) => {
    const wash = over(token("--thoth-accent-soft"), bg(surface));
    expect(ratio(bg("--thoth-accent-ink"), wash)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(surfaces)("focus ring, active-tab line and drop indicator on %s are at least 3:1", (surface) => {
    expect(ratio(accent, bg(surface))).toBeGreaterThanOrEqual(3);
  });

  // The text highlight and the selected row must read as a colour, not blend into the page: 1.25:1 against paper,
  // 1.5:1 against near-black (a dark wash needs more to be seen). Measured against the page, the lighter surface in
  // light and the darker one in dark, so the sidebar (closer to the wash) is not the easier case.
  it.each(["--thoth-accent-soft", "--thoth-moon-soft"])("%s stands out from the page", (name) => {
    const page = bg("--thoth-bg");
    const dark = luminance(page) < 0.5;
    expect(ratio(over(token(name), page), page)).toBeGreaterThanOrEqual(dark ? 1.5 : 1.25);
  });

  it.each(surfaces)("primary text and moon-ink on the highlight over %s are at least 4.5:1", (surface) => {
    const wash = over(token("--thoth-moon-soft"), bg(surface));
    const ink = parse(t["--thoth-ink"]!.split(" ").length === 3 ? `rgb(${t["--thoth-ink"]} / 0.94)` : t["--thoth-ink"]!);
    expect(ratio(over(ink, bg(surface)), wash)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(bg("--thoth-moon-ink"), wash)).toBeGreaterThanOrEqual(4.5);
  });

  it("focus ring on the selected item's wash is at least 3:1", () => {
    for (const surface of surfaces) expect(ratio(accent, over(token("--thoth-accent-soft"), bg(surface)))).toBeGreaterThanOrEqual(3);
  });
});

/** Text tokens on every surface they sit on: the page (dialogs and menus too), the sidebar, and a hover, active or
 * menu-highlight row over each. 4.5:1 because they are body-size text, not large text or UI parts. */
describe.each(Object.entries(themes))("text contrast, %s theme", (_name, theme) => {
  const t: Record<string, string> = { ...block(css, ":root, [data-theme] {"), ...theme };
  const colour = (name: string): Colour => {
    const value = t[name] ?? (() => { throw new Error(`missing ${name}`); })();
    return parse(value.replace("var(--thoth-ink)", t["--thoth-ink"]!).replace(/\s*\/\*.*$/, ""));
  };
  const surfaces: [string, Rgb][] = ["--thoth-bg", "--thoth-bg-sidebar"].flatMap((name) => {
    const base = colour(name).rgb;
    return [[name, base], ...["--thoth-bg-hover", "--thoth-bg-active", "--thoth-moon-soft"].map((wash): [string, Rgb] => [`${wash} over ${name}`, over(colour(wash), base)])];
  });
  const text = ["--thoth-ink-primary", "--thoth-ink-secondary", "--thoth-ink-tertiary", "--thoth-danger", "--thoth-warning"];

  it.each(text)("%s is at least 4.5:1 on every surface", (name) => {
    const low = surfaces.filter(([, back]) => ratio(over(colour(name), back), back) < 4.5).map(([surface]) => surface);
    expect(low).toEqual([]);
  });
});

/** The Papyrus Black roles (ADR-0053): the secondary (blue), the named text colours and the focus parts on the page, the
 * sidebar and the raised container (cards, inputs). 4.5:1 for text, 3:1 for borders of controls and the focus ring. */
describe.each(Object.entries(themes))("Papyrus Black roles, %s theme", (_name, theme) => {
  const t: Record<string, string> = { ...block(css, ":root, [data-theme] {"), ...theme };
  const colour = (name: string): Colour => {
    const value = t[name] ?? (() => { throw new Error(`missing ${name}`); })();
    return parse(value.replace("var(--thoth-ink)", t["--thoth-ink"]!).replace(/\s*\/\*.*$/, ""));
  };
  const rgb = (name: string): Rgb => colour(name).rgb;
  const surfaces = ["--thoth-bg", "--thoth-bg-sidebar", "--thoth-bg-container"];
  const onSurfaces = (name: string, min: number) => {
    const low = surfaces.filter((s) => ratio(over(colour(name), rgb(s)), rgb(s)) < min);
    expect(low).toEqual([]);
  };

  it("secondary: text on it, and on its container, is at least 4.5:1", () => {
    expect(ratio(rgb("--thoth-on-secondary"), rgb("--thoth-secondary"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(rgb("--thoth-on-secondary-container"), rgb("--thoth-secondary-container"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["--thoth-secondary", "--thoth-link", "--thoth-workspace"])("%s as text is at least 4.5:1 on the page, sidebar and container", (name) => onSurfaces(name, 4.5));

  it("links and the workspace badge are the secondary role", () => {
    expect(t["--thoth-link"]).toBe(t["--thoth-secondary"]);
    expect(t["--thoth-workspace"]).toBe(t["--thoth-secondary"]);
  });

  it.each(["--thoth-ink-primary", "--thoth-ink-secondary", "--thoth-ink-tertiary", "--thoth-success", "--thoth-warning", "--thoth-danger", "--thoth-private", "--thoth-accent"])("%s is at least 4.5:1 on the page, sidebar and container", (name) => onSurfaces(name, 4.5));

  it.each(TEXT_COLOURS)("--thoth-text-%s is at least 4.5:1 on the page, sidebar and container", (name) => onSurfaces(`--thoth-text-${name}`, 4.5));

  it.each(["--thoth-accent", "--thoth-outline"])("%s (focus ring, control borders) is at least 3:1 on the page, sidebar and container", (name) => onSurfaces(name, 3));

  it("the focus ring (accent) stays at least 3:1 on a tonal button (the secondary container)", () => {
    expect(ratio(rgb("--thoth-accent"), over(colour("--thoth-secondary-container"), rgb("--thoth-bg")))).toBeGreaterThanOrEqual(3);
  });
});

/** Component pairs of the app rollout (ADR-0053): a callout's 10% tint of its kind colour (editor.css, plain.css) under text,
 * the hover of a tonal button, and text on the raised container (inputs, popovers, the modal). */
describe.each(Object.entries(themes))("Papyrus Black components, %s theme", (_name, theme) => {
  const t: Record<string, string> = { ...block(css, ":root, [data-theme] {"), ...theme };
  const colour = (name: string): Colour => {
    const value = t[name] ?? (() => { throw new Error(`missing ${name}`); })();
    return parse(value.replace("var(--thoth-ink)", t["--thoth-ink"]!).replace(/\s*\/\*.*$/, ""));
  };
  const rgb = (name: string): Rgb => colour(name).rgb;
  const mix = (top: Rgb, back: Rgb, share: number): Rgb => top.map((c, i) => Math.round(c * share + back[i]! * (1 - share))) as Rgb;

  const kinds = ["--thoth-success", "--thoth-warning", "--thoth-danger", "--thoth-link", "--thoth-stone-600", "--thoth-ink-secondary"];
  it.each(kinds)("callout kind %s: primary and tertiary ink on its tint are at least 4.5:1 on the page, sidebar and container", (kind) => {
    const low: string[] = [];
    for (const surface of ["--thoth-bg", "--thoth-bg-sidebar", "--thoth-bg-container"]) {
      const back = rgb(surface);
      const tint = mix(over(colour(kind), back), back, 0.1);
      for (const ink of ["--thoth-ink-primary", "--thoth-ink-tertiary"]) if (ratio(over(colour(ink), tint), tint) < 4.5) low.push(`${ink} on ${kind} over ${surface}`);
    }
    expect(low).toEqual([]);
  });

  it("a tonal button's hover (12% of its text colour in its container) keeps 4.5:1", () => {
    const hover = mix(rgb("--thoth-on-secondary-container"), rgb("--thoth-secondary-container"), 0.12);
    expect(ratio(rgb("--thoth-on-secondary-container"), hover)).toBeGreaterThanOrEqual(4.5);
  });

  it("the mention chip and Workspace badge (on-secondary-container on its container) are at least 4.5:1", () => {
    expect(ratio(rgb("--thoth-on-secondary-container"), rgb("--thoth-secondary-container"))).toBeGreaterThanOrEqual(4.5);
  });

  it("menu highlight (moon-soft over the container) keeps primary ink and the danger text at 4.5:1", () => {
    const wash = over(colour("--thoth-moon-soft"), rgb("--thoth-bg-container"));
    for (const ink of ["--thoth-ink-primary", "--thoth-danger", "--thoth-moon-ink"]) expect(ratio(over(colour(ink), wash), wash)).toBeGreaterThanOrEqual(4.5);
  });
});

/** The feature screens' pairs (ADR-0053 rollout, round 2). One group per area; each pair is text over the surface it sits on. */
describe.each(Object.entries(themes))("Papyrus Black feature screens, %s theme", (_name, theme) => {
  const t: Record<string, string> = { ...block(css, ":root, [data-theme] {"), ...theme };
  const colour = (name: string): Colour => {
    const value = t[name] ?? (() => { throw new Error(`missing ${name}`); })();
    return parse(value.replace("var(--thoth-ink)", t["--thoth-ink"]!).replace(/\s*\/\*.*$/, ""));
  };
  const rgb = (name: string): Rgb => colour(name).rgb;
  const mix = (top: Rgb, back: Rgb, share: number): Rgb => top.map((c, i) => Math.round(c * share + back[i]! * (1 - share))) as Rgb;
  const onPage = ["--thoth-bg", "--thoth-bg-sidebar", "--thoth-bg-container"];
  /** Every ink in `inks` on `wash(surface)` for each surface, at 4.5:1. */
  const check = (inks: string[], wash: (surface: Rgb) => Rgb, surfaces = onPage) => {
    const low: string[] = [];
    for (const surface of surfaces) {
      const w = wash(rgb(surface));
      for (const ink of inks) if (ratio(over(colour(ink), w), w) < 4.5) low.push(`${ink} over ${surface}`);
    }
    expect(low).toEqual([]);
  };

  // Agent Hub and the agent side panel
  it("agents: Moon's container (running badge, the agent's answer, the chosen agent): accent-ink on accent-soft over the page and the container", () =>
    check(["--thoth-accent-ink"], (back) => over(colour("--thoth-accent-soft"), back), ["--thoth-bg", "--thoth-bg-container"]));
  it("agents: the run's transcript (a 10% Moon tint): primary and secondary ink and accent-ink are at least 4.5:1 on the page and the container", () =>
    check(["--thoth-ink-primary", "--thoth-ink-secondary", "--thoth-accent-ink"], (back) => mix(rgb("--thoth-accent"), back, 0.1), ["--thoth-bg", "--thoth-bg-container"]));

  // Settings, connected apps, import, transfer, onboarding, tour, update notice, web sign-in
  it("settings, import, transfer: a chosen card, the segmented control and a hovered recent item (accent-ink on the Moon wash) are at least 4.5:1 over the page, sidebar and container", () =>
    check(["--thoth-accent-ink"], (back) => over(colour("--thoth-accent-soft"), back)));
  it("connected apps, transfer, tour, update notice, sign-in: secondary and tertiary ink and links on a card or popover (the container) are at least 4.5:1", () =>
    check(["--thoth-ink-secondary", "--thoth-ink-tertiary", "--thoth-link"], (back) => back, ["--thoth-bg-container"]));
  it("transfer result and import cards: danger and warning text on the container stay at least 4.5:1", () =>
    check(["--thoth-danger", "--thoth-warning", "--thoth-success"], (back) => back, ["--thoth-bg-container"]));
});

describe("faint ink is not text", () => {
  /** --thoth-ink-faint is under 3:1: fine for disabled items, icons and separators, not for text someone has to read. */
  const files = ["../src/editor.css", "../src/shell.css", "../src/plain.css", "../src/ui.css"];
  it.each(files)("%s uses faint ink as a colour only for disabled items, icons and separators", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const rules = [...source.matchAll(/([^{}]+)\{[^}]*[^-]color:\s*var\(--thoth-ink-faint\)/g)].map((m) => m[1]!.trim());
    expect(rules.filter((selector) => !/disabled|caret|icon|handle|::before/.test(selector))).toEqual([]);
  });
});

describe("accent role tokens", () => {
  it("defines the tab and drop roles in terms of the accent for every theme scope", () => {
    const scope = block(css, ":root, [data-theme] {");
    expect(scope["--thoth-tab-active-line"]).toBe("var(--thoth-accent)");
    expect(scope["--thoth-drop-indicator"]).toBe("var(--thoth-accent)");
    expect(scope["--thoth-tab-active-bg"]).toBe("var(--thoth-bg)");
    expect(scope["--thoth-tab-active-ink"]).toBe("var(--thoth-ink-primary)");
  });

  it("the public share page copies the app's highlight, light and dark", () => {
    const share = readFileSync(new URL("../../../apps/server/assets/share/share.css", import.meta.url), "utf8");
    const darkCopy = block(share.slice(share.indexOf("@media (prefers-color-scheme: dark)")), ":root {");
    expect(block(share, ":root {")["--thoth-moon-soft"]?.toUpperCase()).toBe(light["--thoth-moon-soft"]!.toUpperCase());
    expect(darkCopy["--thoth-moon-soft"]?.toUpperCase()).toBe(night["--thoth-moon-soft"]!.toUpperCase());
  });

  it("System in a dark OS uses the same accent values as Dark", () => {
    for (const name of ["--thoth-accent", "--thoth-on-accent", "--thoth-accent-soft", "--thoth-accent-ink"]) expect(systemDark[name]).toBe(night[name]);
  });
});

describe("app CSS uses the tested accent", () => {
  /** The brand Moon (#E8590C) is for the logo and the website; the app's solid accent is --thoth-accent (AA-tested above). */
  const files = [
    "../src/editor.css",
    "../src/shell.css",
    "../src/plain.css",
    "../src/ui.css",
    "../src/transfer/transfer.css",
    "../../../apps/desktop/src/features/agents/agents.css",
    "../../../apps/desktop/src/features/import/import.css",
    "../../../apps/desktop/src/features/settings/settings.css",
    "../../../apps/web/src/web.css",
  ];
  it.each(files)("%s never uses the brand Moon as a solid colour", (file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source.match(/var\(--thoth-moon\)/g) ?? []).toEqual([]);
  });

  it.each(Object.entries(themes))("pressed tools and context items (moon-ink on moon-soft) are at least 4.5:1, %s", (_name, t) => {
    for (const surface of ["--thoth-bg", "--thoth-bg-sidebar"]) {
      const wash = over(parse(t["--thoth-moon-soft"]!), parse(t[surface]!).rgb);
      expect(ratio(parse(t["--thoth-moon-ink"]!).rgb, wash)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
