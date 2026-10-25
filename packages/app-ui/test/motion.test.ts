import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The motion rules of the app (packages/ui/src/tokens.css, "Motion"), checked on the real CSS: every duration and easing is a
 * token, only cheap properties move, nothing loops, nothing waits on a hint, the editor text never animates, and everything
 * is switched off under `prefers-reduced-motion: reduce`. The website's CSS is not part of this.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TOKENS = read("../../ui/src/tokens.css");
const FILES: Record<string, string> = {
  "packages/app-ui/src/ui.css": read("../src/ui.css"),
  "packages/app-ui/src/shell.css": read("../src/shell.css"),
  "packages/app-ui/src/editor.css": read("../src/editor.css"),
  "packages/app-ui/src/plain.css": read("../src/plain.css"),
  "apps/desktop/src/features/settings/settings.css": read("../../../apps/desktop/src/features/settings/settings.css"),
  "apps/desktop/src/features/import/import.css": read("../../../apps/desktop/src/features/import/import.css"),
  "apps/desktop/src/features/transfer/transfer.css": read("../../../apps/desktop/src/features/transfer/transfer.css"),
  "apps/desktop/src/features/agents/agents.css": read("../../../apps/desktop/src/features/agents/agents.css"),
  "apps/desktop/src/features/onboarding/onboarding.css": read("../../../apps/desktop/src/features/onboarding/onboarding.css"),
  "apps/web/src/web.css": read("../../../apps/web/src/web.css"),
};

// ---------------------------------------------------------------------------------------------------------------------
// A small CSS reader: style rules (with the at-rules around them) and keyframes. Enough for these files.

interface Declaration { prop: string; value: string; important: boolean }
interface Rule { file: string; context: string[]; selector: string; declarations: Declaration[] }
interface Keyframes { file: string; name: string; declarations: Declaration[] }

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsOf(body: string): Declaration[] {
  const out: Declaration[] = [];
  let depth = 0;
  let start = 0;
  const flush = (end: number) => {
    const text = body.slice(start, end).trim();
    start = end + 1;
    const colon = text.indexOf(":");
    if (colon <= 0) return;
    const prop = text.slice(0, colon).trim();
    let value = text.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    out.push({ prop, value, important });
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === ";" && depth === 0) flush(i);
  }
  flush(body.length);
  return out;
}

function parse(file: string, css: string): { rules: Rule[]; keyframes: Keyframes[] } {
  const rules: Rule[] = [];
  const keyframes: Keyframes[] = [];
  const walk = (text: string, context: string[]) => {
    let at = 0;
    while (at < text.length) {
      const open = text.indexOf("{", at);
      if (open < 0) break;
      let depth = 0;
      let close = open;
      for (; close < text.length; close++) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}" && --depth === 0) break;
      }
      // Anything before the last `;` is an `@import` or similar statement.
      const prelude = text.slice(at, open).split(";").pop()!.trim().replace(/\s+/g, " ");
      const inner = text.slice(open + 1, close);
      if (prelude.startsWith("@keyframes")) {
        // Each step of the keyframes is a block of its own; their declarations are all that matter here.
        const declarations: Declaration[] = [];
        let step = 0;
        while (step < inner.length) {
          const o = inner.indexOf("{", step);
          if (o < 0) break;
          const c = inner.indexOf("}", o);
          declarations.push(...declarationsOf(inner.slice(o + 1, c)));
          step = c + 1;
        }
        keyframes.push({ file, name: prelude.replace("@keyframes", "").trim(), declarations });
      } else if (prelude.startsWith("@media") || prelude.startsWith("@supports")) walk(inner, [...context, prelude]);
      else if (!prelude.startsWith("@")) rules.push({ file, context, selector: prelude, declarations: declarationsOf(inner) });
      at = close + 1;
    }
  };
  walk(stripComments(css), []);
  return { rules, keyframes };
}

const parsed = Object.entries(FILES).map(([file, css]) => parse(file, css));
const rules = parsed.flatMap((p) => p.rules);
const keyframes = parsed.flatMap((p) => p.keyframes);
const REDUCE = "@media (prefers-reduced-motion: reduce)";

/** Splits at commas that are not inside parentheses. */
const topLevel = (value: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      parts.push(value.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(value.slice(from).trim());
  return parts;
};

const motionDeclarations = rules.flatMap((rule) => rule.declarations.filter((d) => /^(animation|transition)(-|$)/.test(d.prop)).map((d) => ({ ...d, rule })));
const where = (d: { prop: string; rule: Rule }) => `${d.rule.file}: ${d.rule.selector} { ${d.prop} }`;

// ---------------------------------------------------------------------------------------------------------------------

describe("the reader", () => {
  it("finds the motion in the files it reads (so the checks below are not vacuous)", () => {
    expect(motionDeclarations.length).toBeGreaterThan(50);
    expect(keyframes.map((k) => k.name)).toEqual(expect.arrayContaining(["thoth-fade-in", "thoth-pop-in", "thoth-modal-in", "thoth-tab-out"]));
    expect(rules.some((r) => r.selector === ".tree-collapse")).toBe(true);
  });
});

describe("motion tokens", () => {
  const root = TOKENS.slice(TOKENS.indexOf(":root {"), TOKENS.indexOf("}", TOKENS.indexOf(":root {")));
  const value = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(root)?.[1]?.trim();

  it("has four durations, all under 300ms, and the website's two old names", () => {
    expect([value("--thoth-dur-instant"), value("--thoth-dur-fast"), value("--thoth-dur-base"), value("--thoth-dur-slow")]).toEqual(["80ms", "140ms", "200ms", "280ms"]);
    expect(value("--thoth-dur")).toBe("var(--thoth-dur-base)");
    expect(value("--thoth-ease")).toBe("var(--thoth-ease-out)");
  });

  it("has out, in, emphasized, in-out and spring easings, and the spring has a fallback where linear() is missing", () => {
    for (const name of ["--thoth-ease-out", "--thoth-ease-in", "--thoth-ease-emphasized", "--thoth-ease-in-out"]) expect(value(name), name).toMatch(/^cubic-bezier\(/);
    expect(value("--thoth-ease-spring")).toBe("var(--thoth-ease-emphasized)");
    expect(TOKENS).toMatch(/@supports \(transition-timing-function: linear\(0, 1\)\) \{\s*:root \{[^}]*--thoth-ease-spring: linear\(/);
  });

  it("sets popovers to grow from at least 0.9, never from scale(0), and exits to move less than enters", () => {
    const scale = Number.parseFloat(value("--thoth-pop-scale")!);
    expect(scale).toBeGreaterThanOrEqual(0.9);
    expect(scale).toBeLessThan(1);
    expect(Number.parseFloat(value("--thoth-exit-scale")!)).toBeGreaterThan(scale);
  });

  it("zeroes every duration and distance under reduced motion", () => {
    const start = TOKENS.indexOf(`${REDUCE} {`);
    expect(start).toBeGreaterThan(0);
    const reduced = TOKENS.slice(start, TOKENS.indexOf("\n}\n", start));
    for (const name of ["--thoth-dur-instant", "--thoth-dur-fast", "--thoth-dur-base", "--thoth-dur-slow", "--thoth-dur"]) expect(reduced, name).toMatch(new RegExp(`${name}:\\s*0ms`));
    expect(reduced).toMatch(/--thoth-shift:\s*0px/);
    expect(reduced).toMatch(/--thoth-pop-scale:\s*1;/);
    expect(reduced).toMatch(/--thoth-exit-scale:\s*1;/);
  });
});

describe("reduced motion", () => {
  const override = rules.find((r) => r.file.endsWith("ui.css") && r.context.includes(REDUCE) && r.selector.startsWith("*"));

  it("has one global override that covers animation, transition and smooth scrolling, on every element and pseudo-element", () => {
    expect(override, "a `*` rule inside @media (prefers-reduced-motion: reduce) in ui.css").toBeDefined();
    expect(override!.selector.split(",").map((s) => s.trim())).toEqual(["*", "*::before", "*::after"]);
    const set = Object.fromEntries(override!.declarations.map((d) => [d.prop, d]));
    expect(set["animation"]).toMatchObject({ value: "none", important: true });
    expect(set["transition"]).toMatchObject({ value: "none", important: true });
    expect(set["scroll-behavior"]).toMatchObject({ value: "auto", important: true });
  });

  it("also switches off the theme dissolve (a view transition's pieces are not matched by *)", () => {
    const dissolve = rules.find((r) => r.file.endsWith("ui.css") && r.context.includes(REDUCE) && r.selector.includes("::view-transition-"));
    expect(dissolve, "a ::view-transition-* rule inside the reduced-motion query").toBeDefined();
    expect(dissolve!.selector.split(",").map((s) => s.trim())).toEqual(["::view-transition-group(*)", "::view-transition-old(*)", "::view-transition-new(*)"]);
    expect(dissolve!.declarations).toEqual([{ prop: "animation", value: "none", important: true }]);
  });

  it("only turns motion off under reduced motion, and nothing outside it beats that with !important", () => {
    const underReduce = motionDeclarations.filter((d) => d.rule.context.includes(REDUCE));
    for (const d of underReduce) expect(d, where(d)).toMatchObject({ value: "none", important: true });
    const loud = motionDeclarations.filter((d) => d.important && !d.rule.context.includes(REDUCE));
    expect(loud.map(where)).toEqual([]);
  });

  it("is not switched off for anyone by a no-preference query that re-enables motion", () => {
    for (const css of Object.values(FILES)) expect(css).not.toMatch(/prefers-reduced-motion:\s*no-preference/);
  });
});

describe("what animates, and how", () => {
  const DURATION = /^var\(--thoth-dur-(instant|fast|base|slow)\)$/;
  const EASING = /^var\(--thoth-ease-(out|in|emphasized|in-out|spring)\)$/;
  /** Colour and opacity changes, and the two moves that cost nothing to lay out. The one layout exception is below. */
  const CHEAP = new Set(["color", "background-color", "border-color", "box-shadow", "opacity", "transform", "outline-color"]);
  const KEYFRAME_NAMES = new Set(keyframes.map((k) => k.name));

  it("uses a duration token for every animation and transition, and never a literal time", () => {
    const bad: string[] = [];
    for (const d of motionDeclarations) {
      if (d.value === "none") continue;
      for (const item of topLevel(d.value)) {
        if (d.prop === "transition-timing-function" || d.prop === "animation-timing-function") {
          if (!EASING.test(item)) bad.push(`${where(d)}: ${item}`);
          continue;
        }
        if (!/^(animation|transition)(-duration)?$/.test(d.prop)) continue;
        const time = item.match(/var\(--thoth-dur-[a-z]+\)|(?<![\w-])\d*\.?\d+m?s(?![\w-])/g) ?? [];
        if (time.length !== 1 || !DURATION.test(time[0]!)) bad.push(`${where(d)}: ${item}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("uses an easing token for every animation and transition: no bare ease, ease-in-out or linear", () => {
    const bad: string[] = [];
    for (const d of motionDeclarations) {
      if (d.value === "none" || !/^(animation|transition)$/.test(d.prop)) continue;
      for (const item of topLevel(d.value)) if (!/var\(--thoth-ease-(out|in|emphasized|in-out|spring)\)/.test(item)) bad.push(`${where(d)}: ${item}`);
    }
    expect(bad).toEqual([]);
  });

  it("transitions only colours, opacity and transform, plus grid rows for an opening folder and a progress bar's width", () => {
    const bad: string[] = [];
    for (const d of motionDeclarations) {
      if (!/^transition$/.test(d.prop) || d.value === "none") continue;
      for (const item of topLevel(d.value)) {
        const property = item.split(/\s+/)[0]!;
        const allowed = CHEAP.has(property) || (property === "grid-template-rows" && d.rule.selector === ".tree-collapse") || (property === "width" && d.rule.selector.includes("::-webkit-progress-value"));
        if (!allowed) bad.push(`${where(d)}: ${property}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("names a keyframes rule in every animation, defines every keyframes it names, and leaves none unused", () => {
    const used = new Set<string>();
    const bad: string[] = [];
    for (const d of motionDeclarations) {
      if (d.prop !== "animation" || d.value === "none") continue;
      for (const item of topLevel(d.value)) {
        const name = item.split(/\s+/)[0]!;
        if (!KEYFRAME_NAMES.has(name)) bad.push(`${where(d)}: ${name}`);
        used.add(name);
      }
    }
    expect(bad).toEqual([]);
    expect([...KEYFRAME_NAMES].filter((name) => !used.has(name))).toEqual([]);
  });

  it("moves only opacity and transform in a keyframes rule; the tab strip may also change width", () => {
    const bad: string[] = [];
    for (const k of keyframes) {
      const allowed = k.name.startsWith("thoth-tab-") ? new Set(["opacity", "flex-basis", "min-width", "max-width", "margin-right"]) : new Set(["opacity", "transform"]);
      for (const d of k.declarations) if (!allowed.has(d.prop)) bad.push(`${k.file}: ${k.name} { ${d.prop} }`);
    }
    expect(bad).toEqual([]);
  });

  it("starts nothing from scale(0)", () => {
    for (const css of Object.values(FILES)) expect(css).not.toMatch(/scale\(\s*0\s*\)/);
  });

  it("loops nothing and holds nothing: no infinite animation, no delay, no will-change", () => {
    for (const [file, css] of Object.entries(FILES)) {
      expect(css, file).not.toMatch(/\binfinite\b/);
      expect(css, file).not.toMatch(/will-change/);
      expect(css, file).not.toMatch(/animation-delay|transition-delay/);
    }
  });

  it("never transitions 'all'", () => {
    for (const d of motionDeclarations) expect(d.value, where(d)).not.toMatch(/\ball\b/);
  });

  it("does not animate the text people type in, nor a line of it, nor the caret", () => {
    const touchy = /\.prose|\.ProseMirror|\.cm-|\.plain-editor/;
    expect(motionDeclarations.filter((d) => touchy.test(d.rule.selector)).map(where)).toEqual([]);
  });

  it("dissolves between themes with the base duration and the out curve, as a view transition and never colour by colour", () => {
    const dissolve = rules.find((r) => r.selector.includes("::view-transition-old(root)") && !r.context.includes(REDUCE));
    expect(dissolve).toBeDefined();
    expect(dissolve!.selector.split(",").map((s) => s.trim())).toEqual(["::view-transition-old(root)", "::view-transition-new(root)"]);
    expect(Object.fromEntries(dissolve!.declarations.map((d) => [d.prop, d.value]))).toEqual({ "animation-duration": "var(--thoth-dur-base)", "animation-timing-function": "var(--thoth-ease-out)" });
    expect(Object.values(FILES).join("\n")).not.toContain("data-theme-changing");
  });

  it("keeps dialogs and menus short: nothing uses the slow duration but the first-run screens", () => {
    const slow = motionDeclarations.filter((d) => d.value.includes("--thoth-dur-slow")).map((d) => d.rule.selector).sort();
    expect(slow).toEqual([".onboarding-inner", ".signin-card"]);
  });
});
