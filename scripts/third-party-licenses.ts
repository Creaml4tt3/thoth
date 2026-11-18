/**
 * A Vite plugin that writes `THIRD-PARTY-LICENSES.txt` into a build: the licence text of every npm package whose code or
 * files (fonts, images) end up in the bundle. Apache-2.0 and MIT/BSD/ISC/OFL require the notice to travel with the copy.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BundledPackage {
  dir: string;
  name: string;
  version: string;
  license: string;
}

/** The package that owns a bundled file: the nearest package.json with a name above it, inside `node_modules`. */
export function packageOf(file: string): BundledPackage | null {
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

/** A package's licence texts: LICENSE, LICENSE.md, LICENSE-MIT, COPYING… (all of them for a dual licence), not SPDX metadata. */
export function licenceFiles(names: readonly string[]): string[] {
  return names.filter((f) => /^(licen[sc]e|copying)([-_][\w.-]*)?(\.(txt|md|markdown|rst))?$/i.test(f) && !/\.spdx$/i.test(f)).sort();
}

/** The file's text: a header, then each package's licence file (or what it declares when it ships none). */
export function licenseText(packages: Iterable<BundledPackage>): string {
  const byKey = new Map([...packages].map((p) => [`${p.name}@${p.version}`, p]));
  const parts = ["Thoth's own code in this bundle is Apache-2.0 (https://github.com/Creaml4tt3/thoth).\nThe third-party packages below are bundled with it, under their own licences.\n"];
  for (const key of [...byKey.keys()].sort()) {
    const pkg = byKey.get(key)!;
    const files = licenceFiles(readdirSync(pkg.dir));
    const text = files.length > 0 ? files.map((f) => readFileSync(join(pkg.dir, f), "utf8").trim()).join("\n\n") : `(no licence file shipped; the package declares ${pkg.license})`;
    parts.push(`${"=".repeat(78)}\n${key}  (${pkg.license})\n${"=".repeat(78)}\n${text}\n`);
  }
  return parts.join("\n");
}

/** The little of a Vite/Rollup bundle this reads (vite is not a dependency at the repo root). */
type Bundle = Record<string, { type: "chunk"; modules: Record<string, unknown> } | { type: "asset"; originalFileNames: string[] }>;
interface EmitContext {
  emitFile(file: { type: "asset"; fileName: string; source: string }): string;
}

export function thirdPartyLicenses() {
  return {
    name: "thoth-third-party-licenses",
    apply: "build" as const,
    generateBundle(this: EmitContext, _options: unknown, bundle: Bundle) {
      const found: BundledPackage[] = [];
      for (const item of Object.values(bundle)) {
        // Code comes from a chunk's modules; fonts and images from an asset's source files.
        const sources = item.type === "chunk" ? Object.keys(item.modules) : item.originalFileNames;
        for (const id of sources) {
          const pkg = packageOf(id.split("?")[0]!);
          if (pkg) found.push(pkg);
        }
      }
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-LICENSES.txt", source: licenseText(found) });
    },
  };
}
