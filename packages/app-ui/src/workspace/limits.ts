import { en, type Strings } from "../strings/en.ts";

function bytes(n: number, t: Strings["limits"]): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? t.bytes(n) : `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Advertised limits in plain words. Unknown limits are listed by name so nothing is hidden. */
export function describeLimits(limits: Record<string, number>, t: Strings["limits"] = en.limits): string[] {
  const out: string[] = [];
  for (const [name, n] of Object.entries(limits)) {
    switch (name) {
      case "maxPagesPerWorkspace":
        out.push(t.pages(n));
        break;
      case "maxMembersPerWorkspace":
        out.push(t.members(n));
        break;
      case "maxWorkspacesPerAccount":
        out.push(t.workspaces(n));
        break;
      case "maxWorkspaceAttachmentBytes":
        out.push(t.attachmentsPerWorkspace(bytes(n, t)));
        break;
      case "maxAttachmentBytes":
        out.push(t.perAttachment(bytes(n, t)));
        break;
      case "maxMarkdownBytes":
        out.push(t.perPage(bytes(n, t)));
        break;
      case "revisionRetentionDays":
        out.push(t.retention(n));
        break;
      case "maxPageSize":
      case "idempotencyWindowSeconds":
        break; // protocol tuning, not something a person plans around
      default:
        out.push(`${name}: ${n.toLocaleString()}`);
    }
  }
  return out;
}
