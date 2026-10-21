import type { ImportSourceKind } from "@thoth/domain";
import { normalizeVaultPath, isReservedPath, stripExtension } from "@thoth/domain";

export type System = "notion" | "obsidian";
export type Format = "zip" | "folder";

export function sourceKindFor(system: System, format: Format): ImportSourceKind {
  if (system === "notion") return format === "zip" ? "notion-zip" : "notion-folder";
  return format === "zip" ? "obsidian-zip" : "obsidian-vault";
}

/** `Imports/<name>`: the default destination folder (spec section 7.1 step 6). */
export function defaultDestination(sourceLabel: string): string {
  const name = stripExtension(sourceLabel).replace(/[\\/]+/g, "-").trim() || "Import";
  return `Imports/${name}`;
}

/** Validates the destination folder the user typed. "" means the vault root. */
export function checkDestination(input: string): { ok: true; root: string } | { ok: false; reason: string } {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return { ok: true, root: "" };
  try {
    const root = normalizeVaultPath(trimmed);
    if (isReservedPath(root)) return { ok: false, reason: "The .thoth folder is reserved for Thoth." };
    return { ok: true, root };
  } catch {
    return { ok: false, reason: "That is not a valid folder path inside your Private Space." };
  }
}

export const STEP_NUMBER: Record<string, number> = { source: 1, instructions: 2, pick: 3, preview: 5, destination: 6, options: 7, run: 8, report: 9 };
