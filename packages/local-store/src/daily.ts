/**
 * The daily notes setting of a Private Space (ADR-0051 rules 7, 8 and 11): the folder, the file name pattern and the
 * template of Today's page, in `.thoth/daily.json` beside `favorites.json`, so it travels with the folder. A missing or
 * malformed record is the defaults, 0.6.0's `Daily`, `YYYY-MM-DD` and `Templates/Daily.md`; never an error. Written with
 * the same compare-and-swap as the favorites (`Vault.writeRecordIfUnchanged`), so two windows never lose a choice.
 *
 * Obsidian keeps its own in `.obsidian/daily-notes.json`; it is read once, when that folder has no `daily.json` yet,
 * and never written (ADR-0045).
 */
import { z } from "zod";
import { datePatternProblem, decodeText, formatDate, type DatePatternProblem } from "@thoth/content";
import { checkRelativePath } from "@thoth/domain";
import { ConflictError } from "./errors.ts";
import { entryNameProblem } from "./names.ts";
import type { Vault } from "./vault.ts";

export const DAILY_PATH = ".thoth/daily.json";
export const OBSIDIAN_DAILY_PATH = ".obsidian/daily-notes.json";
const ATTEMPTS = 4;

export interface DailySettings {
  /** Vault-relative folder, without slashes at either end; "" is the top level. */
  folder: string;
  /** The file name, without `.md` (ADR-0051 rule 8); `/` makes subfolders. */
  pattern: string;
  /** The template page's path (with `.md`), or null for none. */
  template: string | null;
}

export const DEFAULT_DAILY: DailySettings = { folder: "Daily", pattern: "YYYY-MM-DD", template: "Templates/Daily.md" };

const DailyRecordSchema = z.object({
  version: z.literal(1),
  folder: z.string().max(1024),
  pattern: z.string().min(1).max(256),
  template: z.string().min(1).max(1024).nullable(),
});

/** Why a setting is refused. */
export type DailyProblem = { field: "folder" } | { field: "template" } | ({ field: "pattern" } & (DatePatternProblem | { kind: "name" }));

/** A path inside the Private Space that the scan lists: relative, no `..`, no reserved or hidden folder, valid names. */
function pathProblem(path: string, last: "file" | "folder"): boolean {
  if (checkRelativePath(path)) return true;
  const segments = path.split("/");
  return segments.some((s, i) => entryNameProblem(s, i === segments.length - 1 ? last : "folder") !== null || s !== s.trim());
}

/** The first problem with `settings`, or null. The pattern is checked by making a name with it. */
export function dailySettingsProblem(settings: DailySettings): DailyProblem | null {
  if (settings.folder !== "" && pathProblem(settings.folder, "folder")) return { field: "folder" };
  const pattern = datePatternProblem(settings.pattern);
  if (pattern) return { field: "pattern", ...pattern };
  // A date that makes every token as long as it gets, so a name that is fine today is fine all year.
  const name = formatDate(settings.pattern, new Date(2026, 8, 30));
  if (pathProblem(`${name}.md`, "file")) return { field: "pattern", kind: "name" };
  if (settings.template !== null && (!settings.template.toLowerCase().endsWith(".md") || pathProblem(settings.template, "file"))) return { field: "template" };
  return null;
}

/** Today's page path for `now` (local date): `<folder>/<pattern>.md`. Assumes settings without a problem. */
export function dailyPath(settings: DailySettings, now: Date): string {
  const name = `${formatDate(settings.pattern, now)}.md`;
  return settings.folder === "" ? name : `${settings.folder}/${name}`;
}

/** The setting as read, whether the record exists, and the hash of its bytes (null: no file), for the next write. */
export interface DailyRead {
  settings: DailySettings;
  exists: boolean;
  hash: string | null;
}

function fromRecord(value: unknown): DailySettings | null {
  const parsed = DailyRecordSchema.safeParse(value);
  if (!parsed.success) return null;
  const { folder, pattern, template } = parsed.data;
  const settings = { folder, pattern, template };
  return dailySettingsProblem(settings) ? null : settings;
}

/** The setting, or the defaults when the record is missing or broken. Never throws. */
export async function readDailySettings(vault: Pick<Vault, "readRecordText">): Promise<DailyRead> {
  try {
    const record = await vault.readRecordText(DAILY_PATH);
    if (!record) return { settings: DEFAULT_DAILY, exists: false, hash: null };
    let value: unknown;
    try {
      value = JSON.parse(record.text);
    } catch {
      value = null;
    }
    return { settings: fromRecord(value) ?? DEFAULT_DAILY, exists: true, hash: record.hash };
  } catch {
    return { settings: DEFAULT_DAILY, exists: false, hash: null };
  }
}

/**
 * Changes the setting: `change` gets it as it is on disk (and whether the record exists) and returns the new one, or
 * null to write nothing. Written only if the file has not changed since it was read; otherwise `change` runs again on
 * what the other window wrote. Returns the setting in force; throws on a refused setting or a file that kept changing.
 */
export async function updateDailySettings(
  vault: Pick<Vault, "readRecordText" | "writeRecordIfUnchanged">,
  change: (current: DailySettings, exists: boolean) => DailySettings | null,
): Promise<DailySettings> {
  let last: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const now = await readDailySettings(vault);
    const next = change(now.settings, now.exists);
    if (next === null) return now.settings;
    const problem = dailySettingsProblem(next);
    if (problem) throw new Error(`Refused daily notes setting (${problem.field})`);
    try {
      await vault.writeRecordIfUnchanged(DAILY_PATH, { version: 1, ...next }, now.hash);
      return next;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("The daily notes setting changed while it was written");
}

/**
 * Obsidian's daily notes setting, from `.obsidian/daily-notes.json`, in Thoth's terms; undefined when the file is
 * missing, unreadable or not a JSON object. Its keys (checked against Obsidian's help and the
 * obsidian-daily-notes-interface library): `folder` ("" or missing: the vault's top level), `format` (Moment.js; "" or
 * missing: `YYYY-MM-DD`) and `template` (a note path, usually without `.md`; "" or missing: none). The result may still
 * have a problem (`dailySettingsProblem`), which the caller shows.
 */
export async function readObsidianDailySettings(vault: Pick<Vault, "fs">): Promise<DailySettings | undefined> {
  try {
    if ((await vault.fs.stat(OBSIDIAN_DAILY_PATH))?.kind !== "file") return undefined;
    const value: unknown = JSON.parse(decodeText(await vault.fs.readFile(OBSIDIAN_DAILY_PATH)).text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return obsidianDailySettings(value as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/** Obsidian's values as Thoth's: slashes trimmed, the default format filled in, `.md` added to the template. */
export function obsidianDailySettings(value: Record<string, unknown>): DailySettings {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, "");
  const template = trimSlashes(text(value["template"]));
  return {
    folder: trimSlashes(text(value["folder"])),
    pattern: text(value["format"]) || "YYYY-MM-DD",
    template: template === "" ? null : template.toLowerCase().endsWith(".md") ? template : `${template}.md`,
  };
}
