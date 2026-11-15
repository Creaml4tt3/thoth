/** The sample vault in memory: a page is a string and a version. Nothing is written anywhere; a reload starts fresh. */
import type { PageStore } from "@thoth/app-ui/editor/page-session.ts";
import type { PageSummary } from "@thoth/domain";
import type { DemoVault } from "./vault/types.ts";

class Stale extends Error {}

export interface Vault {
  name: string;
  first: string;
  folders: string[];
  summaries: PageSummary[];
  titleOf(path: string): string;
  has(path: string): boolean;
  /** The same store for the same page every time: the session pool keys on it. */
  storeFor(path: string): PageStore;
}

const titleFrom = (path: string, source: string): string => /^# (.+)$/m.exec(source)?.[1] ?? path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

export function createVault(def: DemoVault): Vault {
  const pages = new Map(def.pages.map((p) => [p.path, { source: p.source, version: 1 }]));
  const summaries = def.pages.map(
    (p, i): PageSummary => ({
      id: `local:${i.toString(16).padStart(32, "0")}`,
      path: p.path,
      title: titleFrom(p.path, p.source),
      contentHash: "",
      size: p.source.length,
      mtimeMs: Date.UTC(2026, 10, 15),
      aliases: [],
      tags: [],
    }),
  );
  const titles = new Map(summaries.map((s) => [s.path, s.title]));
  const stores = new Map<string, PageStore>();
  const make = (path: string): PageStore => {
    const page = pages.get(path);
    if (!page) throw new Error(`No sample page ${path}`);
    return {
      kind: "file",
      read: async () => ({ source: page.source, hash: `h${page.version}`, editable: true }),
      // Compare-and-swap like a file. Only the page's own session writes, so a stale write cannot happen here.
      write: async (source, expected) => {
        if (expected !== `h${page.version}`) throw new Stale("stale");
        page.source = source;
        page.version += 1;
        return `h${page.version}`;
      },
      // shortcut: a conflict cannot arise with one writer, so no copy is kept; upgrade if the demo ever gets a second writer.
      writeCopy: async () => ({ ref: path, label: path }),
      isConflict: (error) => error instanceof Stale,
    };
  };
  return {
    name: def.name,
    first: def.first,
    folders: def.folders,
    summaries,
    titleOf: (path) => titles.get(path) ?? path,
    has: (path) => pages.has(path),
    storeFor(path) {
      let store = stores.get(path);
      if (!store) stores.set(path, (store = make(path)));
      return store;
    },
  };
}
