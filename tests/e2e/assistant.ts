/**
 * Driving the Thoth assistant in the real desktop UI: the mascot, its prompt bubble, the review tab and
 * Settings → Thoth assistant. Shared by agent-hub.e2e.ts and mascot.e2e.ts.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { settled } from "./settled.ts";

export const mascot = (page: Page): Locator => page.getByRole("button", { name: /^Thoth assistant/ });
export const bubble = (page: Page): Locator => page.getByRole("dialog", { name: "Ask Thoth" });
export const layer = (page: Page): Locator => page.getByTestId("mascot");

/** Opens the bubble (if it is not open) and waits until the chosen agent is detected as ready. */
export async function openBubble(page: Page, agent: "claude" | "codex" = "claude"): Promise<Locator> {
  if (!(await bubble(page).isVisible())) await mascot(page).click();
  await expect(bubble(page)).toBeVisible();
  await expect(bubble(page).locator(`option[value="${agent}"]`)).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  return bubble(page);
}

/** The context picker inside the bubble ("+"). */
export async function picker(page: Page): Promise<Locator> {
  const group = page.getByRole("group", { name: "Pages for the agent" });
  if (!(await group.isVisible())) await bubble(page).getByRole("button", { name: "Add context" }).click();
  await expect(group).toBeVisible();
  return group;
}

/** Only these pages: the current page the bubble adds by default is cleared first. */
export async function pickOnly(page: Page, pages: string[]): Promise<void> {
  const group = await picker(page);
  const clear = group.getByRole("button", { name: "Clear" });
  if (await clear.isVisible()) await clear.click();
  for (const name of pages) await group.getByRole("checkbox", { name, exact: true }).check();
}

export async function writeAndStart(page: Page, prompt: string): Promise<void> {
  await bubble(page).getByRole("textbox", { name: "Task" }).fill(prompt);
  await bubble(page).getByRole("button", { name: "Start" }).click();
}

/** Waits for the run to reach review and opens the review tab from the bubble. */
export async function openReview(page: Page): Promise<Locator> {
  await bubble(page).getByRole("button", { name: "Review the changes" }).click({ timeout: 15_000 });
  const review = page.getByRole("region", { name: "Review the changes" });
  await expect(review).toBeVisible();
  return review;
}

/** Settings → Thoth assistant. */
export async function openAssistantSettings(page: Page): Promise<Locator> {
  if (await bubble(page).isVisible()) await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.getByTestId("assistant-settings");
  await expect(section).toBeVisible();
  return section;
}

/** No serious or critical axe findings inside `selector`. */
export async function axe(page: Page, selector: string | string[]): Promise<void> {
  // A hovered primary button is drawn at 88% opacity, which axe reads as low contrast: park the pointer first.
  await page.mouse.move(0, 0);
  await settled(page);
  let builder = new AxeBuilder({ page });
  for (const s of Array.isArray(selector) ? selector : [selector]) builder = builder.include(s);
  const bad = (await builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
