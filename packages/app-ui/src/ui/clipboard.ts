/** Copies text: the async clipboard where there is one, else the older selection way (some webviews). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The older way, for a webview without the async clipboard.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy refused");
  } finally {
    area.remove();
  }
}
