import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function* tsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsx(path);
    else if (entry.name.endsWith(".tsx")) yield path;
  }
}

describe("dropdowns", () => {
  it("every dropdown is the Thoth Select (ui/Select.tsx), not the system's <select>", () => {
    const sources = ["apps", "packages"].flatMap((top) =>
      readdirSync(join(ROOT, top), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => {
          try {
            return [...tsx(join(ROOT, top, d.name, "src"))];
          } catch {
            return [];
          }
        }),
    );
    expect(sources.length).toBeGreaterThan(50);
    const native = sources.filter((file) => /<select[\s>]/.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file));
    expect(native).toEqual([]);
  });
});
