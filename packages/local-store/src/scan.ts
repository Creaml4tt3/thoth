import type { ScanEntry, VaultFs } from "./ports.ts";

/**
 * `VaultFs.scan` by walking `list` from the root, with `stat` on each file when `stat` is set: what a port without a
 * `scan` of its own costs, one call per folder (and per file). Directories named in `skipDirs` are neither listed nor
 * entered; symlinks are reported, never followed.
 */
export async function scanByListing(fs: Pick<VaultFs, "list" | "stat">, skipDirs: readonly string[], stat: boolean): Promise<ScanEntry[]> {
  const skip = new Set(skipDirs);
  const out: ScanEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.list(dir)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        if (skip.has(entry.name)) continue;
        out.push({ path, kind: "directory" });
        await walk(path);
      } else if (entry.kind === "file" && stat) {
        // Gone since the listing: left out, as a walk that listed a moment later would.
        const st = await fs.stat(path);
        if (st) out.push({ path, kind: st.kind, size: st.size, mtimeMs: st.mtimeMs });
      } else out.push({ path, kind: entry.kind });
    }
  };
  await walk("");
  return out;
}
