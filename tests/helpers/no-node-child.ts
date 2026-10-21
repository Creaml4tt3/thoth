/**
 * Child process for the webview-readiness test. Blocks every Node builtin
 * (`node:*` and bare names like "fs") and yauzl for any module under
 * `packages/` (first-party code), removes Node-only globals, then loads the
 * importer main entries and exercises the portable sources through an
 * in-memory SourceHost. Third-party dependencies resolve as usual: under Node
 * they get their Node builds, which a webview bundler swaps for browser ones.
 * Usage: node no-node-child.ts '<json of base64 archives>'
 */
import { isBuiltin, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const input = JSON.parse(process.argv[2]!) as Record<string, string>;
const write = process.stdout.write.bind(process.stdout);
const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const PACKAGES = new URL("../../packages/", import.meta.url).href;
const blocked: string[] = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? "";
    const firstParty = parent.startsWith(PACKAGES) && !parent.includes("/node_modules/");
    if (firstParty && (specifier.startsWith("node:") || isBuiltin(specifier) || specifier === "yauzl")) {
      blocked.push(`${specifier} from ${fileURLToPath(parent)}`);
      throw new Error(`Blocked builtin import: ${specifier} from ${parent}`);
    }
    return nextResolve(specifier, context);
  },
});
// Node-only globals a webview does not have (first-party code must not rely on them).
for (const name of ["Buffer", "setImmediate", "clearImmediate"]) Reflect.deleteProperty(globalThis, name);

// Control: the hook really does block a first-party builtin import.
let blockedBuiltins = false;
try {
  await import(new URL("../../packages/importer-core/src/node/source-host.ts", import.meta.url).href);
} catch {
  blockedBuiltins = blocked.length > 0;
}
blocked.length = 0;

const core = await import("@thoth/importer-core");
const notion = await import("@thoth/importer-notion");
const obsidian = await import("@thoth/importer-obsidian");
const { MemoryHost } = await import("./memory-host.ts");
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const size = async (chunks: AsyncIterable<Uint8Array>) => {
  let n = 0;
  for await (const c of chunks) n += c.length;
  return n;
};

const flat = await core.openArchiveSource(MemoryHost.file("flat.zip", decode(input["flat"]!)));
const flatResult = { entries: flat.entries.map((e) => e.path), a: text(await flat.read("a.md")), bSize: await size(flat.openReadStream("b.bin")) };
await flat.close();

const nested = await notion.NotionZipImporter.openHost(MemoryHost.file("nested.zip", decode(input["nested"]!)));
const nestedResult = { entries: nested.source.entries.map((e) => e.path), p1: text(await nested.source.read("p1.md")), p2: text(await nested.source.read("p2.md")) };
await nested.source.close();

const folder = await obsidian.ObsidianVaultImporter.openHost(MemoryHost.directory("vault", { "Cafe\u0301.md": "folder" }));
const folderResult = { entries: folder.source.entries.map((e) => e.path), text: text(await folder.source.read("Caf\u00e9.md")) };
await folder.source.close();

if (blocked.length > 0) throw new Error(`First-party code loaded builtins: ${blocked.join(", ")}`);
write(
  JSON.stringify({
    blockedBuiltins,
    flat: flatResult,
    nested: nestedResult,
    folder: folderResult,
    importers: [notion.NotionZipImporter, notion.NotionMarkdownCsvImporter, obsidian.ObsidianVaultImporter, obsidian.ObsidianZipImporter].map((i) => i.id),
  }),
);
