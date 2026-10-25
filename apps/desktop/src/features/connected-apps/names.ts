/** The folder name a Private Space is shown by (the last part of its root), as the host labels it for apps. */
export function folderName(root: string): string {
  const parts = root.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.at(-1) ?? root;
}
