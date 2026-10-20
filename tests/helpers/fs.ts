import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Snapshot of every file (path → sha256, mode, mtime) to prove a source was not mutated. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (rel: string) => {
    for (const d of await readdir(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      const s = await lstat(join(root, path));
      if (d.isDirectory()) {
        result[`${path}/`] = `dir:${s.mtimeMs}`;
        await walk(path);
      } else {
        const hash = d.isFile() ? createHash("sha256").update(await readFile(join(root, path))).digest("hex") : "link";
        result[path] = `${hash}:${s.size}:${s.mtimeMs}:${s.mode}`;
      }
    }
  };
  await walk("");
  return result;
}
