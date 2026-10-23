/// <reference lib="dom" />
/**
 * jsdom has no layout engine. ProseMirror only needs these APIs to exist (it
 * never gets real geometry in tests), so they return empty geometry. Shared by
 * the desktop and web UI tests.
 */
const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
const rects = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList;

if (typeof document !== "undefined") {
  document.elementFromPoint ??= () => null;
  document.elementsFromPoint ??= () => [];
  Range.prototype.getBoundingClientRect ??= rect;
  Range.prototype.getClientRects ??= rects;
  Element.prototype.getClientRects ??= rects;
  Element.prototype.scrollIntoView ??= () => undefined;
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return (this as HTMLElement).textContent ?? "";
    },
    set(value: string) {
      (this as HTMLElement).textContent = value;
    },
  });
}
