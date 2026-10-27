/**
 * The Welcome pages (ADR-0032): what a new, empty Private Space starts with instead of nothing. Real Markdown files,
 * kept in the repo next to this module (`welcome/en`, `welcome/th`), written through the vault's normal write path
 * (compare-and-swap with "must not exist": nothing is ever overwritten), once per Private Space. The record in
 * `.thoth/` says it was done, so pages deleted afterwards never come back.
 */
import { ConflictError, type Vault } from "@thoth/local-store";
import { encodeText } from "@thoth/content";
import type { Lang } from "@thoth/app-ui/strings/index.ts";
import enWelcome from "./welcome/en/welcome.md?raw";
import enLinking from "./welcome/en/linking.md?raw";
import enShortcuts from "./welcome/en/shortcuts.md?raw";
import thWelcome from "./welcome/th/welcome.md?raw";
import thLinking from "./welcome/th/linking.md?raw";
import thShortcuts from "./welcome/th/shortcuts.md?raw";
import image from "./welcome/thoth-welcome.svg?raw";

export interface WelcomeFile {
  /** Where it goes in the Private Space. */
  path: string;
  text: string;
}

export interface WelcomeSet {
  /** The page that opens once the set is written. */
  open: string;
  /** In the order they are written: the Welcome page, its image, then the rest. */
  files: readonly WelcomeFile[];
}

const IMAGE = "thoth-welcome.svg";

export const WELCOME: Record<Lang, WelcomeSet> = {
  en: {
    open: "Welcome to Thoth.md",
    files: [
      { path: "Welcome to Thoth.md", text: enWelcome },
      { path: IMAGE, text: image },
      { path: "Linking pages.md", text: enLinking },
      { path: "Getting started/Keyboard shortcuts.md", text: enShortcuts },
    ],
  },
  // REVIEW: the Thai page names and text want a native reader's pass.
  th: {
    open: "ยินดีต้อนรับสู่ Thoth.md",
    files: [
      { path: "ยินดีต้อนรับสู่ Thoth.md", text: thWelcome },
      { path: IMAGE, text: image },
      { path: "การลิงก์หน้า.md", text: thLinking },
      { path: "เริ่มต้นใช้งาน/แป้นพิมพ์ลัด.md", text: thShortcuts },
    ],
  },
};

/** Written once the set is in place: its presence is what "only once" means. */
export const WELCOME_RECORD = ".thoth/onboarding/welcome.json";

/**
 * Writes the Welcome set of `lang` into an empty Private Space that never had it, and returns the page to open; null
 * when nothing was written (the space has pages, or had the set before). A name that is already taken is skipped.
 */
export async function seedWelcome(vault: Vault, lang: Lang): Promise<string | null> {
  if ((await vault.readRecordText(WELCOME_RECORD)) !== undefined) return null;
  if ((await vault.listPages()).length > 0) return null;
  const set = WELCOME[lang];
  for (const file of set.files) {
    try {
      if (file.path.endsWith(".md")) await vault.writePage(file.path, file.text, { expectedHash: null });
      else await vault.writeFileAtomic(file.path, encodeText(file.text), { expectedHash: null });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  try {
    await vault.writeRecordIfUnchanged(WELCOME_RECORD, { version: 1, lang, files: set.files.map((f) => f.path) }, null);
  } catch (error) {
    // Another window wrote it at the same moment: the set is there either way.
    if (!(error instanceof ConflictError)) throw error;
  }
  return (await vault.pageByPath(set.open)) ? set.open : null;
}
