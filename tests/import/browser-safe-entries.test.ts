import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR-008: the importer main entries run in a Tauri webview. Walks the static
 * import graph of first-party modules reachable from each main entry
 * (following workspace packages through their package.json "exports") and
 * fails on any `node:` specifier, bare Node builtin, or yauzl.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const ENTRIES = ["@thoth/importer-core", "@thoth/importer-notion", "@thoth/importer-obsidian"];
const NODE_BUILTINS = new Set(["assert", "buffer", "child_process", "crypto", "events", "fs", "fs/promises", "module", "net", "os", "path", "process", "stream", "url", "util", "worker_threads", "zlib"]);

/** Every static `import … from "x"`, `export … from "x"`, side-effect `import "x"` and dynamic `import("x")`, comments stripped. */
function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const found: string[] = [];
  for (const re of [/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of code.matchAll(re)) found.push(m[1]!);
  }
  return found;
}

async function workspaceEntry(specifier: string): Promise<string | undefined> {
  const m = /^@thoth\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!m) return undefined;
  const pkgDir = resolve(ROOT, "packages", m[1]!);
  const pkg = JSON.parse(await readFile(resolve(pkgDir, "package.json"), "utf8")) as { exports: Record<string, string> };
  const target = pkg.exports[m[2] ? `.${m[2]}` : "."];
  if (!target) throw new Error(`No export ${specifier}`);
  return resolve(pkgDir, target);
}

async function walk(entry: string): Promise<{ files: string[]; violations: string[] }> {
  const seen = new Set<string>();
  const violations: string[] = [];
  const queue = [(await workspaceEntry(entry))!];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(await readFile(file, "utf8"))) {
      const where = relative(ROOT, file);
      if (spec.startsWith("node:") || NODE_BUILTINS.has(spec) || spec === "yauzl" || spec.startsWith("yauzl/")) {
        violations.push(`${where} imports ${spec}`);
        continue;
      }
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else {
        const ws = await workspaceEntry(spec);
        if (ws) queue.push(ws);
      }
    }
  }
  return { files: [...seen].map((f) => relative(ROOT, f)).sort(), violations };
}

describe("importer main entries are browser-safe", () => {
  it.each(ENTRIES)("%s reaches no node: specifier or yauzl", async (entry) => {
    const { files, violations } = await walk(entry);
    expect(violations).toEqual([]);
    expect(files).toContain("packages/importer-core/src/zip/reader.ts");
    expect(files.some((f) => f.includes("/node/"))).toBe(false);
  });

  it("control: the walker does catch the Node entries", async () => {
    for (const entry of ["@thoth/importer-core/node", "@thoth/importer-notion/node", "@thoth/importer-obsidian/node"]) {
      const { violations } = await walk(entry);
      expect(violations.some((v) => v.includes("source-host.ts imports node:fs"))).toBe(true);
    }
    expect(specifiers(`import x from "node:a";\nexport { y } from 'yauzl';\nimport "node:b";\nconst z = await import("node:c");\n// import "node:hidden"\n/* import "node:d" */`)).toEqual(["node:a", "yauzl", "node:b", "node:c"]);
  });
});
