import * as nodePath from "node:path";
import { Vault, type ReconcileReport } from "../vault.ts";
import { NodeVaultFs } from "./node-fs.ts";
import { NodeSqlDriver } from "./node-sqlite.ts";

export { NodeSqlDriver } from "./node-sqlite.ts";
export { NodeVaultFs } from "./node-fs.ts";

/** Opens a vault on the local filesystem with Node's built-in SQLite. */
export async function openNodeVault(root: string): Promise<{ vault: Vault; fs: NodeVaultFs; report: ReconcileReport }> {
  const fs = new NodeVaultFs(root);
  await fs.mkdirp(".thoth");
  const sql = new NodeSqlDriver(nodePath.join(fs.root, ".thoth", "index.sqlite"));
  const { vault, report } = await Vault.open({ fs, sql });
  return { vault, fs, report };
}
