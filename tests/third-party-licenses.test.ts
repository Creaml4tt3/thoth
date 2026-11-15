import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { licenseText, packageOf } from "../scripts/third-party-licenses.ts";

function fakePackage(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, "node_modules", name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

describe("third-party licences", () => {
  const root = mkdtempSync(join(tmpdir(), "thoth-licences-"));
  const a = fakePackage(root, "@scope/a", { "package.json": '{"name":"@scope/a","version":"1.0.0","license":"MIT"}', LICENSE: "MIT text" });
  // A nested package.json without a name (an ESM marker) is skipped for the real one above it.
  writeFileSync(join(a, "dist", "package.json"), '{"type":"module"}');
  fakePackage(root, "b", { "package.json": '{"name":"b","version":"2.0.0","license":{"type":"ISC"}}' });

  it("finds the package that owns a bundled file, and nothing outside node_modules", () => {
    expect(packageOf(join(a, "dist", "index.js"))).toMatchObject({ name: "@scope/a", version: "1.0.0", license: "MIT" });
    expect(packageOf(join(root, "node_modules", "b", "dist", "x.js"))?.license).toBe("ISC");
    expect(packageOf("/repo/packages/app-ui/src/x.ts")).toBeNull();
  });

  it("writes each package once, sorted, with its licence text or what it declares", () => {
    const pa = packageOf(join(a, "dist", "index.js"))!;
    const pb = packageOf(join(root, "node_modules", "b", "dist", "x.js"))!;
    const text = licenseText([pb, pa, pa]);
    expect(text.match(/@scope\/a@1\.0\.0/g)).toHaveLength(1);
    expect(text.indexOf("@scope/a@1.0.0")).toBeLessThan(text.indexOf("b@2.0.0"));
    expect(text).toContain("MIT text");
    expect(text).toContain("(no licence file shipped; the package declares ISC)");
  });
});
