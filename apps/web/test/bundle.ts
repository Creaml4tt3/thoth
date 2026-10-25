/**
 * What the web client's production bundle must never contain (spec §14.11): filesystem, Tauri and process code, the
 * Agent Hub's host commands and CLI flags, and the desktop's system notifications (ADR-0018). A browser can never read
 * local files or spawn a CLI. Shared by `build.test.ts` and the MVP scenario (`tests/e2e/mvp.e2e.ts`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DESKTOP_ONLY = [
  // Link previews are fetched by the desktop host only (ADR-0020): the web client shows plain links.
  "link.preview",
  "link_preview",
  // The update notice asks for the desktop's own releases through the desktop host only (ADR-0022): the web client is
  // always current, so its bundle has neither the commands nor the address of latest.json.
  "update.check",
  "update_check",
  "update.settings",
  "update_settings",
  "latest.json",
  "@tauri-apps",
  "plugin:fs",
  "child_process",
  "__TAURI_INTERNALS__",
  "@thoth/local-store",
  "openVault",
  "node:fs",
  "node:sqlite",
  "agent.start",
  "agent.run.create",
  "agent_start",
  "stream-json",
  "--permission-mode",
  "--skip-git-repo-check",
  "default_permissions=thoth",
  "plugin-notification",
  "plugin:notification",
  "sendNotification",
  "isPermissionGranted",
  "__THOTH_NOTIFICATION_PLUGIN__",
  // Connected apps are the desktop host's (ADR-0021 rule 6): the web client has no setting, no prompt, no answers.
  "mcp.settings",
  "mcp.answer",
  "thoth:mcp-request",
  "thoth-mcp",
  "connected-apps-settings",
];

export function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

/** The built JavaScript, CSS and HTML of `dist`. */
export function bundleCode(dist: string): { f: string; text: string }[] {
  return files(dist)
    .filter((f) => /\.(js|css|html)$/.test(f))
    .map((f) => ({ f, text: readFileSync(f, "utf8") }));
}

/** `forbidden → files that contain it`, for every desktop-only name found in the bundle; empty when the bundle is clean. */
export function desktopOnlyIn(dist: string): Record<string, string[]> {
  const code = bundleCode(dist);
  const found: Record<string, string[]> = {};
  for (const forbidden of DESKTOP_ONLY) {
    const where = code.filter((c) => c.text.includes(forbidden)).map((c) => c.f);
    if (where.length > 0) found[forbidden] = where;
  }
  return found;
}
