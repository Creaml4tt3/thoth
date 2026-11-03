/**
 * The link suggestion menu, shared by both editor modes and both triggers: an ARIA listbox (see `suggest-menu.ts`)
 * of pages after `[[`, and of pages, folders and (in a workspace) people after `@` (ADR-0049).
 */
import { createSuggestMenu, type SuggestMenu } from "./suggest-menu.ts";
import type { LinkSuggestion } from "./link-suggest.ts";
import type { EditorStrings } from "../strings/en.ts";

export type TriggerKind = "wiki" | "at";

export interface LinkMenu extends Omit<SuggestMenu<LinkSuggestion>, "show"> {
  show(items: LinkSuggestion[], query: string, rect: DOMRect | null, kind: TriggerKind, people?: boolean): void;
}

export function createLinkMenu(owner: HTMLElement, onPick: (item: LinkSuggestion) => void, strings: EditorStrings): LinkMenu {
  let kind: TriggerKind = "wiki";
  const menu = createSuggestMenu<LinkSuggestion>(owner, {
    prefix: "link",
    label: strings.linkToPage,
    render: (item) => {
      const what = item.kind === "folder" ? strings.linkFolder : item.kind === "person" ? strings.linkPerson : "";
      const detail = [what, item.alias ? strings.linkAlias(item.alias) : "", item.folder].filter(Boolean).join(" · ");
      return { title: item.title, ...(detail ? { meta: detail } : {}) };
    },
    empty: (query) => (kind === "at" ? strings.linkAtNoMatch(query.trim()) : query.trim() ? strings.linkNoMatch(query.trim()) : strings.linkNoPages),
    onPick,
  });
  return {
    ...menu,
    show(items, query, rect, next, people = false) {
      kind = next;
      menu.show(items, query, rect, next === "at" ? strings.linkMention(people) : strings.linkToPage);
    },
  };
}
