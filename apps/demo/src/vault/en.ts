/**
 * The sample notes, copied verbatim from the Head of Marketing's demo vault (`demo-vault/en/notes/`). The wording is
 * not ours to edit; the site's captures show the same text.
 */
import type { DemoVault } from "./types.ts";

export const en: DemoVault = {
  name: "notes",
  first: "Weekend plans.md",
  folders: ["Recipes"],
  pages: [
    { path: "Weekend plans.md", source: `# Weekend plans

A slow Saturday, then the coast on Sunday.

- [x] Book the train
- [ ] Pack a blanket and the camera
- [ ] Buy fruit at the market

> [!note] Leave by eight
> The road to the coast is quiet before nine.

> [!toggle]- Rainy day backup
> The bookshop café, then a film at home.
` },
    { path: "Book club.md", source: `# Book club

Thursday, 7 pm, at Ploy's.

This month: Piranesi. Bring one quote you liked.
` },
    { path: "Ideas.md", source: `# Ideas

- A notebook for every trip
- Learn to make proper coffee
- Plant herbs on the balcony
` },
    { path: "Reading list.md", source: `# Reading list

- [ ] The Overstory
- [ ] A Psalm for the Wild-Built
- [x] Piranesi

Talk about it at [[Book club]] on Thursday.
` },
    { path: "Recipes/Green curry.md", source: `# Green curry

Curry paste, coconut milk, chicken, Thai eggplant and sweet basil.

Fry the paste in the thick coconut cream first.
` },
    { path: "Recipes/Lemon cake.md", source: `# Lemon cake

Two lemons, three eggs, one cup of flour, half a cup of sugar.

Bake at 180 °C for 35 minutes.
` },
  ],
};
