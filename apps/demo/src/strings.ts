/**
 * The words the demo adds to the app's own strings, from the Head of Marketing's WORDS-interactive.md (2026-11-15; draft
 * until the owner picks the option). Everything else the demo shows (tabs, tree, editor menus) is the app's existing text.
 * The Thai lines are all marked REVIEW.
 */
import type { Lang } from "@thoth/app-ui/strings/en.ts";

export interface DemoStrings {
  /** The label of the Blocks | Plain switch (narrow screens). */
  switchGroup: string;
  blocks: string;
  plain: string;
  /** The compare section, for screen readers. */
  compareRegion: string;
  /** The window section, for screen readers. */
  windowRegion: string;
  startOver: string;
  /** Shown while an editor has focus. */
  escHint: string;
}

export const demoStrings: Record<Lang, DemoStrings> = {
  en: {
    switchGroup: "Editing mode",
    blocks: "Blocks",
    plain: "Plain",
    compareRegion: "Try Blocks and Plain: one page in both editors",
    windowRegion: "A working Thoth window, with sample notes",
    startOver: "Start over",
    escHint: "Press Esc to leave the editor.",
  },
  th: {
    switchGroup: "โหมดแก้ไข", // REVIEW
    blocks: "บล็อก", // REVIEW
    plain: "ข้อความล้วน", // REVIEW
    compareRegion: "ลองโหมดบล็อกกับข้อความล้วน: หน้าเดียวกันในทั้งสองโหมด", // REVIEW
    windowRegion: "หน้าต่าง Thoth ที่ใช้งานได้จริง พร้อมโน้ตตัวอย่าง", // REVIEW
    startOver: "เริ่มใหม่", // REVIEW
    escHint: "กด Esc เพื่อออกจากตัวแก้ไข", // REVIEW
  },
};
