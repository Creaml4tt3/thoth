/**
 * The sidebar's target folder (the last folder clicked, or the folder of the last page clicked; "" is the top level),
 * for what creates files outside the tree: New board on the Board tab (ADR-0056) goes where New page would.
 * shortcut: one value per window (a window has one sidebar); lift it into the session if a second reader needs updates.
 */
let folder = "";

export const targetFolder = (): string => folder;
export const setTargetFolder = (next: string): void => void (folder = next);
