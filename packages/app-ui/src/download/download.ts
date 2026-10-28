/**
 * Download as Markdown: a page's text as one `.md` file, named after its title. The desktop asks the host for a "Save
 * as" dialog; the web lets the browser download it. Pictures stay as the links the page has.
 */
/** A file name from a title: no folder separators or characters a system refuses, at most 120 characters, `.md`. */
export function markdownFileName(title: string): string {
  const stem = title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 120)
    .trimEnd();
  return `${stem || "Untitled"}.md`;
}

/** The browser's download of `text` as `name` (the web client). Always true: the browser has no "cancelled". */
export function downloadInBrowser(name: string, text: string, doc: Document = document): boolean {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  // After the click has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export type SaveFile = (name: string, text: string) => Promise<boolean>;
