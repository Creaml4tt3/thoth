/**
 * `pnpm --filter @thoth/demo check`: fails when dist/ holds anything the demo promises not to have. No network code, no
 * storage, and nothing that needs `'unsafe-eval'` or `'wasm-unsafe-eval'` under
 * `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`.
 *
 * ALLOWED is the list of known-harmless matches (library feature detection that never runs a request); it is empty today:
 * the build disables Vite's modulePreload polyfill (the one `fetch(`) and swaps the editor-mode module that reads localStorage.
 * Add an entry only with the reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const BANNED = ["eval(", "new Function", "WebAssembly", "fetch(", "XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage", "indexedDB", "document.cookie", "sendBeacon", "EventSource", "importScripts", "new Worker"] as const;
export const ALLOWED: readonly { pattern: string; file: RegExp; why: string }[] = [];

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** The banned strings found in `text`, minus the allowed ones for `file`. */
export function violations(file: string, text: string): string[] {
  return BANNED.filter((p) => text.includes(p) && !ALLOWED.some((a) => a.pattern === p && a.file.test(file)));
}

export function checkDist(dist: string): string[] {
  const problems: string[] = [];
  for (const file of walk(dist).filter((f) => /\.(js|css|html)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    const rel = relative(dist, file);
    for (const p of violations(rel, text)) problems.push(`${rel}: ${p}`);
    if (file.endsWith(".js") && /(?:^|[^\w.])import\(\s*["'`]https?:/.test(text)) problems.push(`${rel}: import() of an outside address`);
    // The page must not pull in anything from elsewhere: a script, style or image from an outside origin breaks the policy.
    if (file.endsWith(".html") && /<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i.test(text)) problems.push(`${rel}: an outside resource`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkDist(join(import.meta.dirname, "..", "dist"));
  if (problems.length > 0) {
    console.error(`dist/ breaks the demo's rules:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("dist/ is clean: no network code, no storage, nothing that needs unsafe-eval.");
}
