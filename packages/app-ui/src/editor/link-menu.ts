/**
 * The `[[` suggestion menu, shared by both editor modes: an ARIA listbox of
 * pages (see `suggest-menu.ts`).
 */
import { createSuggestMenu, type SuggestMenu } from "./suggest-menu.ts";
import type { LinkSuggestion } from "./link-suggest.ts";
import type { EditorStrings } from "../strings/en.ts";

export type LinkMenu = SuggestMenu<LinkSuggestion>;

export function createLinkMenu(owner: HTMLElement, onPick: (item: LinkSuggestion) => void, strings: EditorStrings): LinkMenu {
  return createSuggestMenu<LinkSuggestion>(owner, {
    prefix: "link",
    label: strings.linkToPage,
    render: (item) => {
      const detail = [item.alias ? strings.linkAlias(item.alias) : "", item.folder].filter(Boolean).join(" · ");
      return { title: item.title, ...(detail ? { meta: detail } : {}) };
    },
    empty: (query) => (query.trim() ? strings.linkNoMatch(query.trim()) : strings.linkNoPages),
    onPick,
  });
}
