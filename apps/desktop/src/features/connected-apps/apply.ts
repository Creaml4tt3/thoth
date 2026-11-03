/**
 * Applying a connected app's proposed change (ADR-0048) in this window's Vault, with compare-and-swap: a page is
 * written only while it is still the version the proposal was made from, and a new page only where there is no file.
 * When the page changed meanwhile the proposal becomes `conflicted` and nothing is written; the user then sees the
 * diff against the page as it is now, and may apply it over that version on purpose (never over a file a new page
 * would replace).
 */
import { ConflictError, type Vault } from "@thoth/local-store";
import type { ConnectedAppProposalText, ConnectedApps } from "@thoth/platform";

/** The page as it is now: its text and version, or null when there is no such file. */
export interface CurrentPage {
  source: string;
  hash: string;
}

export type ApplyOutcome = { status: "applied" } | { status: "conflicted"; current: CurrentPage | null };

export async function currentPage(vault: Vault, path: string): Promise<CurrentPage | null> {
  try {
    const page = await vault.readPage(path);
    return { source: page.source, hash: page.hash };
  } catch {
    return null;
  }
}

/**
 * Writes the proposal if its page is unchanged, then tells the host. `over`: the current page the user chose to apply
 * it over (after seeing that diff); only for a change to a page, never for a new one.
 */
export async function applyProposal(vault: Vault, apps: ConnectedApps, proposal: ConnectedAppProposalText, over?: CurrentPage | null): Promise<ApplyOutcome> {
  if (proposal.after === null) throw new Error("This proposal was already settled");
  if (over !== undefined && proposal.kind === "create") throw new Error("A new page never replaces a file");
  const expectedHash = over === undefined ? proposal.baseHash : (over?.hash ?? null);
  try {
    await vault.writePage(proposal.path, proposal.after, { expectedHash });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    if (proposal.status !== "conflicted") await apps.settle(proposal.id, "conflicted");
    return { status: "conflicted", current: await currentPage(vault, proposal.path) };
  }
  // Written: the host only records it. If that fails (it expired meanwhile), the page stays as applied.
  await apps.settle(proposal.id, "applied").catch(() => undefined);
  return { status: "applied" };
}
