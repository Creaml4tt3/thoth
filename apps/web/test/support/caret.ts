/** Puts the caret at the end of the text in `block` (jsdom cannot hit-test a mouse click). */
export function caretAtEnd(block: Element): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n as Text;
  const selection = document.getSelection()!;
  const range = document.createRange();
  if (last) range.setStart(last, last.length);
  else range.setStart(block, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}
