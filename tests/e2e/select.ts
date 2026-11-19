/** Driving the Thoth Select (packages/app-ui/src/ui/Select.tsx) in the real UI, in place of `selectOption`. */
import { expect, type Locator } from "@playwright/test";

/** Opens the select and clicks the option named `name` (an exact label, or a pattern for a label with a prefix). */
export async function choose(select: Locator, name: string | RegExp): Promise<void> {
  await select.click();
  const list = select.page().locator(`[id="${await select.getAttribute("aria-controls")}"]`);
  await list.getByRole("option", typeof name === "string" ? { name, exact: true } : { name }).click();
  await expect(select).toHaveAttribute("aria-expanded", "false");
}

/** The chosen value, as the select carries it (`data-value`). */
export const valueOf = (select: Locator): Promise<string | null> => select.getAttribute("data-value");
