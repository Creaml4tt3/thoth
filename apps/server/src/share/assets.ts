import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shared pages' stylesheet and fonts (apps/server/assets/share), served at `/assets/share/<name>`. Only the names
 * listed here exist. The Vercel build (scripts/build-vercel.ts) has no file tree to read from, so it replaces this
 * module with `inlineShareAssetsModule()`'s output, which embeds the same bytes.
 */
export const SHARE_ASSET_TYPES: Readonly<Record<string, string>> = {
  "share.css": "text/css; charset=utf-8",
  "inter-latin-wght-normal.woff2": "font/woff2",
  "inter-latin-ext-wght-normal.woff2": "font/woff2",
  "noto-sans-thai-thai-wght-normal.woff2": "font/woff2",
};

export const SHARE_ASSET_DIR = join(import.meta.dirname, "..", "..", "assets", "share");

export interface ShareAsset {
  type: string;
  bytes: Buffer;
}

const cache = new Map<string, ShareAsset>();

export function shareAsset(name: string): ShareAsset | null {
  if (!Object.hasOwn(SHARE_ASSET_TYPES, name)) return null;
  let asset = cache.get(name);
  if (!asset) {
    asset = { type: SHARE_ASSET_TYPES[name]!, bytes: readFileSync(join(SHARE_ASSET_DIR, name)) };
    cache.set(name, asset);
  }
  return asset;
}

/** JavaScript source of a module with the same `shareAsset` export, the bytes embedded (base64). For bundles. */
export function inlineShareAssetsModule(): string {
  const entries = Object.entries(SHARE_ASSET_TYPES).map(([name, type]) => `  ${JSON.stringify(name)}: { type: ${JSON.stringify(type)}, data: ${JSON.stringify(readFileSync(join(SHARE_ASSET_DIR, name)).toString("base64"))} }`);
  return `import { Buffer } from "node:buffer";
const FILES = {
${entries.join(",\n")}
};
const cache = new Map();
export const SHARE_ASSET_TYPES = Object.fromEntries(Object.entries(FILES).map(([n, f]) => [n, f.type]));
export function shareAsset(name) {
  if (!Object.hasOwn(FILES, name)) return null;
  let asset = cache.get(name);
  if (!asset) {
    asset = { type: FILES[name].type, bytes: Buffer.from(FILES[name].data, "base64") };
    cache.set(name, asset);
  }
  return asset;
}
`;
}
