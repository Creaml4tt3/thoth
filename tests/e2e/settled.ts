import type { Page } from "@playwright/test";

/**
 * Waits until every CSS animation and transition on the page that will end has ended. The app's motion is short (under
 * 300ms), but a check that reads colours (axe) or takes a picture must not see a dialog half faded in. Looping animations
 * (a text caret blinking) are left out: they never finish.
 *
 * One look is not enough: an animation can end and the next one start on the following style update (a folder that opens
 * after a drop re-renders first, then slides its rows for 140ms). So after the running ones end it waits two frames and
 * looks again, and stops at the first pass that finds nothing (at most 20 passes, so nothing can hang it). It cannot wait
 * for an animation that does not exist yet: a test that needs the result of an action first waits for what the UI shows,
 * then calls this.
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const finite = () => document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    for (let pass = 0; pass < 20; pass++) {
      const running = finite();
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
      await frame();
      await frame();
      if (finite().length === 0) return;
    }
  });
}
