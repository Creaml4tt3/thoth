import { randomBytes } from "node:crypto";
import { chmod, link, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { generateToken, hashToken } from "./auth.ts";
import type { Database, Queryable } from "./db.ts";
import { assertCanAddMember, assertCanCreateAccount, assertCanOwnAnotherWorkspace, type Quotas } from "./quota.ts";
import { opaqueId } from "./ids.ts";

export type Role = "owner" | "editor" | "viewer";
export const ROLES: readonly Role[] = ["owner", "editor", "viewer"];

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}

/**
 * Creates an account. The account quota (`MAX_ACCOUNTS`) is enforced here, in the one function every
 * account creation goes through, so later sign-in code reuses it. A full server throws `ApiError("quota_exceeded")`
 * (the CLI maps it to exit 2).
 */
export async function createUser(db: Database, input: { name: string; email?: string }, quotas: Quotas = {}): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) throw new AdminError("name must be 1 to 200 characters");
  const id = opaqueId("usr");
  await db.tx(async (tx) => {
    await assertCanCreateAccount(tx, quotas);
    await tx.query("INSERT INTO users (id, display_name, email) VALUES ($1, $2, $3)", [id, name, input.email ?? null]);
    await tx.query("INSERT INTO audit_events (actor_id, action, detail) VALUES (NULL, 'user.created', $1)", [JSON.stringify({ userId: id })]);
  });
  return { id };
}

/**
 * Creates a workspace. With `ownerId` the owner's membership is created in the same transaction and the
 * per-account workspace quota applies; without one (an unowned workspace) there is no account to count.
 */
export async function createWorkspace(db: Database, input: { name: string; exportRestricted: boolean; ownerId?: string }, quotas: Quotas = {}): Promise<{ id: string }> {
  return db.tx((tx) => createWorkspaceIn(tx, input, quotas));
}

/** `createWorkspace` inside the caller's transaction (the sign-in broker creates a new account's first workspace with the account). */
export async function createWorkspaceIn(tx: Queryable, input: { name: string; exportRestricted: boolean; ownerId?: string }, quotas: Quotas = {}): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) throw new AdminError("name must be 1 to 200 characters");
  const id = opaqueId("ws");
  if (input.ownerId !== undefined) {
    if ((await tx.query("SELECT 1 FROM users WHERE id = $1", [input.ownerId])).rowCount === 0) throw new AdminError("no such user");
    await assertCanOwnAnotherWorkspace(tx, quotas, input.ownerId);
  }
  await tx.query("INSERT INTO workspaces (id, name, export_restricted) VALUES ($1, $2, $3)", [id, name, input.exportRestricted]);
  if (input.ownerId !== undefined) await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [id, input.ownerId]);
  await tx.query("INSERT INTO audit_events (actor_id, workspace_id, action, detail) VALUES (NULL, $1, 'workspace.created', $2)", [id, JSON.stringify({ exportRestricted: input.exportRestricted })]);
  return { id };
}

const NAME_MAX = 200;

/**
 * The name of a new account's first workspace: "<display name>'s workspace", or "My workspace" when there is no
 * name. A name that is an email address (providers fall back to it) is not used: members would see it.
 */
export function firstWorkspaceName(displayName: string | undefined): string {
  const name = displayName?.trim();
  if (!name || /^[^\s@]+@[^\s@]+$/.test(name)) return "My workspace";
  const suffix = "'s workspace";
  // Cut by code point, so a long name never splits a surrogate pair.
  return `${[...name].slice(0, NAME_MAX - suffix.length).join("").trimEnd()}${suffix}`;
}

/**
 * Adds a member or changes a role. A NEW membership counts against the member quota (a role change does not),
 * and an `owner` membership counts against the account's workspace quota. The last owner cannot be demoted. The workspace row is locked like
 * every other write, so concurrent additions cannot overshoot.
 */
export async function addMember(db: Database, input: { workspaceId: string; userId: string; role: string }, quotas: Quotas = {}): Promise<void> {
  if (!(ROLES as readonly string[]).includes(input.role)) throw new AdminError(`role must be one of ${ROLES.join(", ")}`);
  await db.tx(async (tx) => {
    const ws = await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [input.workspaceId]);
    if (ws.rowCount === 0) throw new AdminError("no such workspace");
    const user = await tx.query("SELECT 1 FROM users WHERE id = $1", [input.userId]);
    if (user.rowCount === 0) throw new AdminError("no such user");
    const existing = (await tx.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [input.workspaceId, input.userId])).rows[0];
    if (!existing) await assertCanAddMember(tx, quotas, input.workspaceId);
    // ADR-0024: a workspace always keeps at least one owner, also through the CLI.
    if (existing?.role === "owner" && input.role !== "owner") {
      const owners = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner'", [input.workspaceId])).rows[0]!.n);
      if (owners <= 1) throw new AdminError("that user is the workspace's last owner; make another member an owner first");
    }
    if (input.role === "owner" && existing?.role !== "owner") await assertCanOwnAnotherWorkspace(tx, quotas, input.userId);
    await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role", [input.workspaceId, input.userId, input.role]);
    await tx.query("INSERT INTO audit_events (actor_id, workspace_id, action, detail) VALUES (NULL, $1, 'member.set', $2)", [input.workspaceId, JSON.stringify({ userId: input.userId, role: input.role })]);
  });
}

export async function revokeToken(db: Queryable, tokenId: string): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [tokenId]);
  if ((rowCount ?? 0) > 0) await db.query("INSERT INTO audit_events (actor_id, action, detail) VALUES (NULL, 'token.revoked', $1)", [JSON.stringify({ tokenId })]);
  return (rowCount ?? 0) > 0;
}

/**
 * Writes `contents` to `path` with mode 0600, atomically, refusing to overwrite an existing file.
 * The temporary file is created with 0600 from the start, so the secret is never readable by others.
 */
export async function writeSecretFile(path: string, contents: string): Promise<void> {
  const target = resolve(path);
  const temp = join(dirname(target), `.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    // link + unlink instead of rename: fails if the target exists rather than replacing it.
    await link(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AdminError(`${path} already exists; refusing to overwrite it`);
    throw error;
  }
  await unlink(temp);
  await chmod(target, 0o600);
}

/**
 * Creates a personal access token for a user. The token is written ONLY to `outFile`; the database
 * receives its SHA-256. Returns the token ID (not secret) so the token can be revoked.
 */
export async function createToken(db: Queryable, input: { userId: string; outFile: string; label?: string; expiresInDays?: number }): Promise<{ tokenId: string }> {
  const user = await db.query("SELECT 1 FROM users WHERE id = $1", [input.userId]);
  if (user.rowCount === 0) throw new AdminError("no such user");
  const token = generateToken();
  // The file is written first: if it cannot be written, no token exists. If the insert then fails, the file holds a dead token.
  await writeSecretFile(input.outFile, `${token}\n`);
  const tokenId = opaqueId("tok");
  try {
    await db.query("INSERT INTO access_tokens (id, user_id, token_hash, label, expires_at) VALUES ($1, $2, $3, $4, $5)", [tokenId, input.userId, hashToken(token), input.label ?? null, input.expiresInDays === undefined ? null : new Date(Date.now() + input.expiresInDays * 86_400_000)]);
  } catch (error) {
    await unlink(input.outFile).catch(() => undefined);
    throw error;
  }
  await db.query("INSERT INTO audit_events (actor_id, action, detail) VALUES (NULL, 'token.created', $1)", [JSON.stringify({ tokenId, userId: input.userId })]);
  return { tokenId };
}
