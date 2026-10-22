/**
 * The `[[` suggestion menu, shared by both editor modes: an ARIA listbox of
 * pages (see `suggest-menu.ts`).
 */
import { createSuggestMenu, type SuggestMenu } from "./suggest-menu.ts";
import type { LinkSuggestion } from "./link-suggest.ts";

export type LinkMenu = SuggestMenu<LinkSuggestion>;

export function createLinkMenu(owner: HTMLElement, onPick: (item: LinkSuggestion) => void): LinkMenu {
  return createSuggestMenu<LinkSuggestion>(owner, {
    prefix: "link",
    label: "Link to page",
    render: (item) => {
      const detail = [item.alias ? `alias “${item.alias}”` : "", item.folder].filter(Boolean).join(" · ");
      return { title: item.title, ...(detail ? { meta: detail } : {}) };
    },
    empty: (query) => (query.trim() ? `No page matches “${query.trim()}”. Keep typing to link to a new page.` : "No other pages yet."),
    onPick,
  });
}
