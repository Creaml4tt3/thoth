import type { Page } from "@playwright/test";

/**
 * Waits until every CSS animation and transition on the page that will end has ended. The app's motion is short (under
 * 300ms), but a check that reads colours (axe) or takes a picture must not see a dialog half faded in. Looping animations
 * (a text caret blinking) are left out: they never finish.
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
  });
}
