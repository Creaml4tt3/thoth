import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { thirdPartyLicenses } from "../../scripts/third-party-licenses.ts";
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

export default defineConfig({
  // Relative: the site copies dist/ to wherever it likes.
  base: "./",
  plugins: [memoryMode(), react(), csp(), thirdPartyLicenses()],
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
