/** Human-readable explanations for the warning codes the importers and pipeline emit (text in `src/strings`). */
import { en, type DesktopStrings } from "../../strings/index.ts";

export interface WarningInfo {
  title: string;
  explanation: string;
}

export function describeWarning(code: string, t: DesktopStrings["wizard"] = en.wizard): WarningInfo {
  const known: Record<string, WarningInfo> = t.warnings;
  return Object.hasOwn(known, code) ? known[code]! : { title: code.replace(/_/g, " "), explanation: t.unknownWarning };
}

export const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };
