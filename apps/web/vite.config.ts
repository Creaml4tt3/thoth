import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** The trial server (ADR-0015). A build for another server sets VITE_DEFAULT_SERVER. */
export const DEFAULT_SERVER = "https://api.thoth.creaml4tt3.me";

/** The server's origin, refusing anything that is not an https origin (plain http only on a loopback host). */
export function serverOrigin(raw: string): string {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`VITE_DEFAULT_SERVER must be an https origin (http only on a loopback host), got ${raw}`);
  }
  return url.origin;
}

/** Puts the server's origin into the Content-Security-Policy in index.html. */
function csp(origin: string): Plugin {
  return {
    name: "thoth-csp",
    transformIndexHtml: (html) => html.replaceAll("%THOTH_SERVER_ORIGIN%", origin),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "VITE_");
  const origin = serverOrigin(env["VITE_DEFAULT_SERVER"] || DEFAULT_SERVER);
  return {
    base: "/app/",
    plugins: [react(), csp(origin)],
    clearScreen: false,
    define: { "import.meta.env.VITE_DEFAULT_SERVER": JSON.stringify(origin) },
    build: { outDir: "dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
  };
});
