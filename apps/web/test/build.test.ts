import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleCode, desktopOnlyIn, files } from "./bundle.ts";

const app = resolve(import.meta.dirname, "..");
const dist = join(app, "dist");
const SERVER = "http://127.0.0.1:9";

describe("web client production build", () => {
  it("builds under /app/ for the configured server, with no filesystem, Tauri, process or agent code (spec 14.11)", () => {
    const vite = join(app, "node_modules/.bin/vite");
    const result = spawnSync(vite, ["build", "--logLevel", "warn"], { cwd: app, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", VITE_DEFAULT_SERVER: SERVER, VITE_GA4_ID: "" } });
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const built = files(dist);
    const html = readFileSync(join(dist, "index.html"), "utf8");
    const code = bundleCode(dist);
    expect(code.length).toBeGreaterThan(2);

    // The Agent Hub's host commands and the Claude Code adapter are desktop only: a browser can never spawn a CLI.
    // System notifications are desktop only too (ADR-0018): no notification plugin, no permission request.
    expect(desktopOnlyIn(dist)).toEqual({});
    // No fonts or scripts from anywhere but /app/ (self-hosted fonts; no Google Fonts).
    for (const c of code) expect(c.text, c.f).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(built.filter((f) => f.endsWith(".woff2")).length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/src="\/app\/assets\/index-[\w-]+\.js"/);

    expect(html).toContain('<meta name="robots" content="noindex" />');
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(csp).toBeDefined();
    const directives = Object.fromEntries(csp!.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual(["'self'", SERVER, "https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.googletagmanager.com"]);
    expect(directives["script-src"]).toEqual(["'self'", "https://www.googletagmanager.com"]);
    // Images in pages are shown from blob: URLs the page makes from authorised downloads (ADR-0028); never the server's own address.
    expect(directives["img-src"]).toEqual(["'self'", "data:", "blob:", "https://*.google-analytics.com", "https://www.googletagmanager.com"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'none'"]);
    expect(directives["form-action"]).toEqual(["'self'", SERVER]);
    // The server address is the one fixed at build time; the trial's default does not leak into this build.
    expect(code.some((c) => c.text.includes(SERVER))).toBe(true);
    expect(code.some((c) => c.text.includes("api.thothnotes.com"))).toBe(false);
    // Without a GA4 ID no analytics script is referenced.
    expect(html).not.toContain("analytics.js");
  }, 120_000);

  it("with a GA4 ID, includes the site's /analytics.js (one consent banner for site and client)", () => {
    const vite = join(app, "node_modules/.bin/vite");
    const result = spawnSync(vite, ["build", "--logLevel", "warn"], { cwd: app, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", VITE_DEFAULT_SERVER: SERVER, VITE_GA4_ID: "G-TEST000000" } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).toContain('<script type="module" src="/analytics.js"></script>');
    // The ID itself lives in /analytics.js (the site build), not in the client.
    expect(files(dist).some((f) => readFileSync(f).includes("G-TEST000000"))).toBe(false);
  }, 120_000);
});
