import { expect, type Page } from "@playwright/test";

/**
 * A new page called `name` in the Private Space, the way people make one since 0.2.6: Cmd/Ctrl+N makes "Untitled"
 * (in the folder last clicked) and starts its rename in the tree, which takes the name. `folder` (one level) is made
 * first when it is not there, from the empty area's menu, and the page goes in it through New page inside.
 */
export async function newPrivatePage(page: Page, name: string, folder?: string): Promise<void> {
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  if (folder) {
    const row = tree.getByRole("treeitem", { name: folder, exact: true });
    if ((await row.count()) === 0) {
      await page.locator(".private-tree").click({ button: "right", position: { x: 4, y: 4 } });
      await page.getByRole("menu").getByRole("menuitem", { name: "New folder" }).click();
      await page.getByRole("textbox", { name: /^Rename Untitled folder/ }).fill(folder);
      await page.keyboard.press("Enter");
      await expect(row).toBeFocused();
    }
    const menu = page.getByRole("menu", { name: `Actions for ${folder}` });
    await expect(async () => {
      await row.click({ button: "right" });
      await expect(menu).toBeVisible({ timeout: 1000 });
    }).toPass();
    await menu.getByRole("menuitem", { name: "New page inside" }).click();
  } else {
    await page.keyboard.press("ControlOrMeta+n");
  }
  const field = page.getByRole("textbox", { name: /^Rename Untitled/ });
  await expect(field).toBeFocused();
  await field.fill(name);
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
  await expect(page.getByRole("tab", { selected: true })).toHaveText(name);
}
