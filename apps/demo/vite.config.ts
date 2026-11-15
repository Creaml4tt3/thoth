import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { scopeCss } from "./postcss-scope.ts";

/** The page this build serves under `vite preview` and in `dist/`, and what a page that embeds the demo may do. */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

/** The test page under the policy the site will serve it with; dev keeps none (the dev server injects inline scripts). */
function csp(): Plugin {
  return {
    name: "thoth-demo-csp",
    apply: "build",
    transformIndexHtml: (html) => html.replace("<!-- thoth:csp -->", `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

/** The editor mode lives in localStorage in the app; the demo stores nothing, so the app's module is swapped for an in-memory one. */
function memoryMode(): Plugin {
  const shim = resolve(import.meta.dirname, "src/shim/mode.ts");
  return {
    name: "thoth-demo-memory-mode",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./mode.ts" && importer && /app-ui\/src\/editor\/[^/]+$/.test(importer.split("?")[0]!)) return shim;
      return null;
    },
  };
}

/** The package that owns a bundled file: the nearest package.json above it, in a `node_modules` directory. */
function packageOf(file: string): { dir: string; name: string; version: string; license: string } | null {
  if (!file.includes("/node_modules/")) return null;
  for (let dir = dirname(file); dir.includes("/node_modules/"); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string; license?: string | { type?: string }; licenses?: { type: string }[] };
    if (!pkg.name) continue;
    const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(" OR ") ?? "UNKNOWN");
    return { dir, name: pkg.name, version: pkg.version ?? "", license };
  }
  return null;
}

/** `dist/THIRD-PARTY-LICENSES.txt`: licence text and copyright of every third-party package in the bundle (a small script, not a plugin dependency). */
function licenses(): Plugin {
  return {
    name: "thoth-demo-licenses",
    generateBundle(_options, bundle) {
      const found = new Map<string, NonNullable<ReturnType<typeof packageOf>>>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          const pkg = packageOf(id.split("?")[0]!);
          if (pkg) found.set(`${pkg.name}@${pkg.version}`, pkg);
        }
      }
      const parts = [
        "Thoth's own code in this bundle is Apache-2.0 (https://github.com/Creaml4tt3/thoth).\nThe third-party packages below are bundled with it, under their own licences.\n",
      ];
      for (const key of [...found.keys()].sort()) {
        const pkg = found.get(key)!;
        const file = readdirSync(pkg.dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
        const text = file ? readFileSync(join(pkg.dir, file), "utf8").trim() : `(no licence file shipped; the package declares ${pkg.license})`;
        parts.push(`${"=".repeat(78)}\n${key}  (${pkg.license})\n${"=".repeat(78)}\n${text}\n`);
      }
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-LICENSES.txt", source: parts.join("\n") });
    },
  };
}

export default defineConfig({
  // Relative: the site copies dist/ to wherever it likes.
  base: "./",
  plugins: [memoryMode(), react(), csp(), licenses()],
  css: { postcss: { plugins: [scopeCss()] } },
  clearScreen: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    // The polyfill fetch()es the modulepreload links; the demo has no network code, and every browser the site supports has modulepreload.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // A stable name for the entry the site references; the lazy chunks and styles keep their hashes.
      output: { entryFileNames: "demo.js" },
    },
  },
});
