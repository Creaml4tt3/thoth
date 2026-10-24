/**
 * Which gestures open a page in a new tab (ADR-0016 rule 5): Cmd/Ctrl+click, middle-click, and Cmd/Ctrl+Enter on
 * a focused row. Anything else opens in the current tab. The trees and the search results share these.
 */
import type { OpenOptions } from "./model.ts";

type Modified = { metaKey: boolean; ctrlKey: boolean };

/** The options for a click: Cmd/Ctrl held opens a new tab. */
export const clickOpens = (event: Modified): OpenOptions | undefined => (event.metaKey || event.ctrlKey ? { newTab: true } : undefined);

/** True for a middle-click (`auxclick` with button 1). */
export const isMiddleClick = (event: { button: number }): boolean => event.button === 1;

/** True for Cmd/Ctrl+Enter, with no other modifier. */
export const isOpenInNewTabKey = (event: Modified & { key: string; altKey: boolean; shiftKey: boolean }): boolean =>
  event.key === "Enter" && (event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey) && !event.altKey && !event.shiftKey;
