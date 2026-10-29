/**
 * How a link in a page opens (0.2.7, owner):
 * - a page link (`[[…]]`): a click opens it here; Cmd/Ctrl+click or a middle-click in a new tab; Shift+click in a new
 *   window (the desktop; a new tab elsewhere);
 * - a web link: a plain click only puts the cursor in it, to edit it; Cmd/Ctrl+click or a middle-click opens it in the
 *   browser. Shift+click keeps extending the selection.
 * The tooltip on hover says so.
 */
import type { OpenOptions } from "../tabs/model.ts";
import type { EditorStrings } from "../strings/en.ts";

type Pointer = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

/** How a click or a middle-click on a page link opens it. */
export function pageLinkOpens(event: Pointer): OpenOptions | undefined {
  if (event.button === 1 || event.metaKey || event.ctrlKey) return { newTab: true };
  if (event.shiftKey) return { newWindow: true };
  return undefined;
}

/** True when a click on a web link opens it: Cmd/Ctrl held, or the middle button. */
export const webLinkOpens = (event: Pointer): boolean => event.button === 1 || ((event.metaKey || event.ctrlKey) && !event.shiftKey);

/** The tooltip's "how to open" line, for Mac or the other systems. */
export function linkHint(strings: EditorStrings, kind: "page" | "web", mac: boolean = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "")): string {
  const mod = mac ? "Cmd" : "Ctrl";
  return kind === "page" ? strings.linkOpenPage(mod) : strings.linkOpenWeb(mod);
}
