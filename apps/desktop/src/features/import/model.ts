import type { ImportSourceKind } from "@thoth/domain";
import { normalizeVaultPath, isReservedPath } from "@thoth/domain";

export type System = "notion" | "obsidian";
export type Format = "zip" | "folder";

export function sourceKindFor(system: System, format: Format): ImportSourceKind {
  if (system === "notion") return format === "zip" ? "notion-zip" : "notion-folder";
  return format === "zip" ? "obsidian-zip" : "obsidian-vault";
}

/** Validates the destination folder the user typed. "" means the vault root. The reason is a key of the wizard's destination text. */
export function checkDestination(input: string): { ok: true; root: string } | { ok: false; reason: "reserved" | "invalid" } {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return { ok: true, root: "" };
  try {
    const root = normalizeVaultPath(trimmed);
    if (isReservedPath(root)) return { ok: false, reason: "reserved" };
    return { ok: true, root };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export const STEP_NUMBER: Record<string, number> = { source: 1, instructions: 2, pick: 3, preview: 5, destination: 6, options: 7, run: 8, report: 9 };
