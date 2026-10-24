import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** WCAG AA for the accent roles of Phase 3b AC 2, computed from the real token CSS in both themes. */
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

  it("focus ring on the selected item's wash is at least 3:1", () => {
    for (const surface of surfaces) expect(ratio(accent, over(token("--thoth-accent-soft"), bg(surface)))).toBeGreaterThanOrEqual(3);
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
    "../../../apps/desktop/src/features/transfer/transfer.css",
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
