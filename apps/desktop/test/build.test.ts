import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = resolve(import.meta.dirname, "..");
const dist = join(app, "dist");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("production build", () => {
  it("builds with Vite and the bundle has no node: imports", () => {
    const vite = join(app, "node_modules/.bin/vite");
    const result = spawnSync(vite, ["build"], { cwd: app, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const built = files(dist);
    expect(built.some((f) => f.endsWith("index.html"))).toBe(true);
    const code = built.filter((f) => /\.(js|css|html)$/.test(f));
    expect(code.length).toBeGreaterThan(1);
    const offenders: string[] = [];
    for (const file of code) {
      const text = readFileSync(file, "utf8");
      if (/from\s*["']node:|import\(\s*["']node:|require\(\s*["']node:|["']node:(fs|path|os|crypto|sqlite|child_process|url|stream|zlib|buffer)["']/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    const js = built.filter((f) => f.endsWith(".js")).reduce((n, f) => n + statSync(f).size, 0);
    expect(js).toBeGreaterThan(50_000);

    // Fonts ship inside the app (Inter latin + latin-ext, Noto Sans Thai), never from the network or the system.
    const fonts = built.filter((f) => f.endsWith(".woff2")).map((f) => f.slice(f.lastIndexOf("/") + 1));
    for (const face of ["inter-latin-wght-normal", "inter-latin-ext-wght-normal", "noto-sans-thai-thai-wght-normal"]) {
      expect(fonts.some((f) => f.startsWith(face)), face).toBe(true);
    }
    expect(fonts).toHaveLength(3);
    expect(built.filter((f) => f.endsWith(".woff2")).reduce((n, f) => n + statSync(f).size, 0)).toBeLessThan(200_000);
    const css = built.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
    const sources = [...css.matchAll(/@font-face\s*{[^}]*?src:\s*url\(([^)]+)\)/g)].map((m) => m[1]!.replace(/["']/g, ""));
    expect(sources).toHaveLength(3);
    for (const src of sources) expect(src, src).toMatch(/^(\.\/|\/assets\/)[\w.-]+\.woff2$/);
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|@import\s+url\(\s*["']?https?:/);
    expect(css).toMatch(/--thoth-font-sans:\s*"Inter Variable",\s*"Noto Sans Thai"/);
    // The fonts' SIL Open Font License travels with them in the app.
    for (const name of ["OFL-Inter.txt", "OFL-NotoSansThai.txt"]) {
      expect(readFileSync(join(dist, "fonts", name), "utf8"), name).toContain("SIL Open Font License, Version 1.1");
    }
  }, 120_000);
});
