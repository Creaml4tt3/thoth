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
  }, 120_000);
});
