import { expect, type Page } from "@playwright/test";

/** The onboarding's main button (ADR-0051 rule 3). */
export const START = /start a new private space/i;

/**
 * Presses "Start a new Private Space" (by click, or by focus and Enter with `keyboard`) and, when the folder already
 * holds Markdown and was never a Private Space, answers the note that comes first (ADR-0051 rule 4) with Open.
 */
export async function pickSpace(page: Page, options: { keyboard?: boolean } = {}): Promise<void> {
  const start = page.getByRole("button", { name: START });
  if (options.keyboard) {
    await start.focus();
    await page.keyboard.press("Enter");
  } else await start.click();
  const note = page.getByRole("dialog", { name: /open this folder where it is/i });
  // Wait for one of the ends: the note, the "Ready" screen of an empty folder, or the space open (its tree). The button
  // going away is not enough: it also hides while the folder is looked at, before the note.
  const ready = page.getByRole("heading", { name: "Ready", level: 1 });
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  await expect(note.or(ready).or(tree)).toBeVisible({ timeout: 20_000 });
  if (!(await note.isVisible())) return;
  const open = note.getByRole("button", { name: "Open", exact: true });
  if (options.keyboard) {
    await open.focus();
    await page.keyboard.press("Enter");
  } else await open.click();
}
