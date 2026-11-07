/**
 * Skills (ADR-0052 rule 7): `Skills/<name>/SKILL.md` in a Private Space, in the Agent Skills format (agentskills.io),
 * with any other files of the skill beside it. Read here for `list_skills` and `get_skill`; agents change skills only
 * as proposals the user reviews.
 */
import { parseFrontmatter } from "@thoth/content";
import { collisionKey } from "@thoth/domain";
import type { Vault } from "./vault.ts";

export const SKILLS_FOLDER = "Skills";
export const SKILL_FILE = "SKILL.md";
/** The most skills listed, and the largest skill file read (1 MB). */
export const MAX_SKILLS = 200;
export const MAX_SKILL_FILE = 1024 * 1024;
/** The most other files named with a skill. */
const MAX_FILES = 100;
/** The Agent Skills limit on a description, in characters. */
const MAX_DESCRIPTION = 1024;

export interface SkillSummary {
  /** The skill's folder name: the name `get_skill` takes. */
  name: string;
  description: string;
  path: string;
}

export interface SkillFile {
  name: string;
  path: string;
  text: string;
  /** The skill's other files, relative to its folder, sorted. */
  files: string[];
}

/** `Skills/<name>/SKILL.md`, in any letter case: the skill's folder name, else null. */
function skillOf(path: string): string | null {
  const parts = path.split("/");
  if (parts.length !== 3 || collisionKey(parts[0]!) !== collisionKey(SKILLS_FOLDER) || collisionKey(parts[2]!) !== collisionKey(SKILL_FILE)) return null;
  return parts[1]!.startsWith(".") ? null : parts[1]!;
}

const oneLine = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** Every skill in the Private Space, by name, with the description its frontmatter gives ("" without one). */
export async function listSkills(vault: Pick<Vault, "listPages" | "readPage">): Promise<SkillSummary[]> {
  const found = (await vault.listPages()).flatMap((p) => {
    const name = skillOf(p.path);
    return name === null ? [] : [{ name, path: p.path }];
  });
  found.sort((a, b) => a.name.localeCompare(b.name));
  const skills: SkillSummary[] = [];
  for (const { name, path } of found.slice(0, MAX_SKILLS)) {
    const source = await vault.readPage(path).then(
      (r) => r.source,
      () => null,
    );
    if (source === null) continue; // gone since the index listed it
    const description = [...oneLine(parseFrontmatter(source).data.description)].slice(0, MAX_DESCRIPTION).join("");
    skills.push({ name, description, path });
  }
  return skills;
}

/**
 * The skill `name`'s `SKILL.md`, or `file` in its folder (a text file of at most 1 MB), and the folder's other files.
 * Null when there is no such skill or file. Names and paths match as the vault matches them (case, Unicode form).
 */
export async function readSkill(vault: Pick<Vault, "listPages" | "readPage" | "scanFiles" | "fs">, name: string, file?: string): Promise<SkillFile | null> {
  const page = (await vault.listPages()).find((p) => {
    const skill = skillOf(p.path);
    return skill !== null && collisionKey(skill) === collisionKey(name);
  });
  if (!page) return null;
  const folder = page.path.slice(0, page.path.lastIndexOf("/"));
  const inside = (await vault.scanFiles()).files
    .filter((f) => collisionKey(f).startsWith(`${collisionKey(folder)}/`))
    .map((f) => f.slice(folder.length + 1))
    .filter((f) => f.split("/").every((part) => !part.startsWith(".")));
  const wanted = file === undefined ? SKILL_FILE : file;
  const relative = inside.find((f) => collisionKey(f) === collisionKey(wanted));
  if (relative === undefined) return null;
  const path = `${folder}/${relative}`;
  const files = inside.filter((f) => f !== relative).sort((a, b) => a.localeCompare(b)).slice(0, MAX_FILES);
  const skill = page.path.split("/")[1]!;
  if (/\.md$/i.test(relative)) {
    const read = await vault.readPage(path).catch(() => null);
    return read && { name: skill, path, text: read.source, files };
  }
  const stat = await vault.fs.stat(path);
  if (stat?.kind !== "file" || stat.size > MAX_SKILL_FILE) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await vault.fs.readFile(path));
  } catch {
    return null; // not text: an agent reads such files from the skill folder itself
  }
  return { name: skill, path, text, files };
}
