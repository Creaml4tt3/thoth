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
  // Either the note is shown, or the folder is opening ("Opening…") or open: the button is gone.
  await expect.poll(async () => (await note.isVisible()) || !(await start.isVisible()), { timeout: 20_000 }).toBe(true);
  if (!(await note.isVisible())) return;
  const open = note.getByRole("button", { name: "Open", exact: true });
  if (options.keyboard) {
    await open.focus();
    await page.keyboard.press("Enter");
  } else await open.click();
}
