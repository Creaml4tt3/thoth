/// <reference lib="dom" />
/**
 * Driving the Thoth Select (packages/app-ui/src/ui/Select.tsx) in UI tests, in place of `userEvent.selectOptions`:
 * its options are in the page only while it is open.
 */
import { fireEvent, within } from "@testing-library/react";

/** The labels of every option, in order (opens the select and closes it again without choosing). */
export function selectLabels(select: HTMLElement): string[] {
  fireEvent.click(select);
  const labels = within(listOf(select)).getAllByRole("option").map((o) => o.textContent ?? "");
  fireEvent.keyDown(select, { key: "Escape" });
  return labels;
}

/** The value of the chosen option. */
export const selectValue = (select: HTMLElement): string => select.dataset["value"] ?? "";

/** The label of the chosen option. */
export const selectedLabel = (select: HTMLElement): string => select.querySelector(".select-value")?.textContent ?? "";

/** Chooses the option whose label is `name` (or matches it), as a click would. */
export function chooseOption(select: HTMLElement, name: string | RegExp): void {
  if (select.getAttribute("aria-expanded") !== "true") fireEvent.click(select);
  fireEvent.click(within(listOf(select)).getByRole("option", { name }));
}

function listOf(select: HTMLElement): HTMLElement {
  const id = select.getAttribute("aria-controls");
  const list = id ? document.getElementById(id) : null;
  if (!list) throw new Error(`the select "${select.getAttribute("aria-label") ?? select.textContent}" did not open`);
  return list;
}

