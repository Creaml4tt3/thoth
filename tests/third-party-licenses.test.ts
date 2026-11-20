import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { licenceFiles, licenseText, packageOf } from "../scripts/third-party-licenses.ts";

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

  it("names what the OCR module download contains (ADR-0055)", () => {
    const text = licenseText([]);
    for (const name of ["OpenThai OCR 2.1 by iApp Technology (Apache-2.0)", "PaddleOCR PP-OCRv5", "ONNX Runtime 1.28.0 by Microsoft (MIT)", "oar-ocr (Apache-2.0)", "hayro (Apache-2.0 OR MIT)", "NOTICE"]) expect(text).toContain(name);
  });

  it("takes every licence text of a dual-licensed package, never the SPDX metadata", () => {
    expect(licenceFiles(["package.json", "LICENSE.spdx", "LICENSE-MIT", "LICENSE-APACHE-2.0", "README.md"])).toEqual(["LICENSE-APACHE-2.0", "LICENSE-MIT"]);
    expect(licenceFiles(["LICENSE.md", "licence", "COPYING", "LICENSE-MIT.txt", "LICENSES.json", "license.js", "LICENSE-MIT.spdx"])).toEqual(["COPYING", "LICENSE-MIT.txt", "LICENSE.md", "licence"]);
    const dual = fakePackage(root, "dual", { "package.json": '{"name":"dual","version":"1.0.0","license":"Apache-2.0 OR MIT"}', "LICENSE.spdx": "SPDXVersion: SPDX-2.1", "LICENSE-MIT": "MIT text", "LICENSE-APACHE-2.0": "Apache text" });
    const text = licenseText([packageOf(join(dual, "dist", "x.js"))!]);
    expect(text).toContain("MIT text");
    expect(text).toContain("Apache text");
    expect(text).not.toContain("SPDXVersion");
  });

  it("lists d3-force (the Board layout) with its ISC licence text", () => {
    const entry = createRequire(join(process.cwd(), "packages/app-ui/package.json")).resolve("d3-force");
    const pkg = packageOf(entry)!;
    expect(pkg).toMatchObject({ name: "d3-force", license: "ISC" });
    expect(licenseText([pkg])).toMatch(/d3-force@\S+[\s\S]*Permission to use, copy, modify/);
  });
});
