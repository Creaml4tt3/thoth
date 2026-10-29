/**
 * Dragging pages from one space onto the other: from the Private Space tree onto a workspace, or from a workspace
 * tree onto the Private Space (ADR-0006, amendment of 2026-10-26). Such a drop never transfers anything by itself:
 * it asks for the transfer dialog, prefilled, which still shows its preview and waits for the person to confirm.
 *
 * Each tree keeps its own drag and drop (`useTreeDnd`); this module is what the trees share while a drag crosses
 * from one to the other. The browser hides drag data until the drop, so the dragged pages are also kept here (the
 * tree under the pointer reads them during `dragover`), and they travel as `application/x-thoth-page` data too.
 *
 *     beginSpaceDrag(drag)          the source tree, at dragstart
 *     currentSpaceDrag()            the tree under the pointer, during dragover
 *     setSpaceHover / clearSpaceHover   what the pointer badge says, and which destination is lit
 *     dropAcrossSpaces(drop)        the target, at the drop: listeners (the desktop shell) open the dialog
 *     endSpaceDrag()                dragend, or any drop
 */
import { useSyncExternalStore } from "react";
import { roleCan, type Role } from "@thoth/workspace-protocol";
import type { ServerDirectory } from "../workspace/directory.ts";
import type { Strings } from "../strings/en.ts";

/** The drag data type that carries a `SpaceDrag` as JSON. */
export const SPACE_DRAG_TYPE = "application/x-thoth-page";

export type Space = { kind: "private" } | { kind: "workspace"; server: string; workspace: string };

export interface SpaceDrag {
  from: Space;
  /** The dragged row: a vault path (Private Space) or a page ID (workspace). */
  row: string;
  /** What would travel: vault paths of pages, or workspace page IDs, parents before children. Never empty. */
  ids: string[];
  /** The dragged row's name (the dialog's title for a workspace page). */
  title: string;
  /** Private Space only: the folder the pages are taken relative to; a dragged folder's parent, so the folder travels too. */
  base?: string;
}

/** Where a drop would land: a folder of the Private Space ("" is its top level), or a workspace with a parent page (null: its top level). */
export type SpaceDestination = { kind: "private"; folder: string } | { kind: "workspace"; server: string; workspace: string; parentId: string | null };

export interface SpaceDrop {
  drag: SpaceDrag;
  to: SpaceDestination;
  /** Move, unless Alt/Option was held at the drop (a copy). */
  mode: "copy" | "move";
}

export type Direction = "to_workspace" | "from_workspace" | "between_workspaces";

/**
 * Which transfer a drop of a drag from `from` onto `to` would start; null within one space. Two workspaces, on one
 * server or two, are two spaces (ADR-0006, amendment of 2026-10-27).
 */
export function crossDirection(from: Space, to: Space): Direction | null {
  if (from.kind === "private") return to.kind === "workspace" ? "to_workspace" : null;
  if (to.kind === "private") return "from_workspace";
  return from.server === to.server && from.workspace === to.workspace ? null : "between_workspaces";
}

/** What the drop rules need to know about the workspace on the other end. */
export interface WorkspaceAccess {
  name: string;
  serverName: string;
  /** Null when the workspace is not (or no longer) in the list. */
  role: Role | null;
  signedIn: boolean;
  /** Whether the server lists `transfers`; null while its capabilities are not known (the preview then says). */
  transfers: boolean | null;
  exportRestricted: boolean;
}

export type SpaceRefusal = "signed_out" | "no_transfers" | "viewer" | "export_restricted";

/**
 * Why a drop across spaces is refused before the dialog could even open, or null. The workspace is the destination
 * (to_workspace) or the source (from_workspace); between two workspaces both ends are asked, the destination as
 * to_workspace and the source as from_workspace (`betweenRefusal`). The server still decides (ADR-0009); this only
 * spares people a dialog that could not start. Moving out of a workspace one only views is left to the dialog,
 * which says so.
 */
export function spaceDropRefusal(direction: Exclude<Direction, "between_workspaces">, access: WorkspaceAccess): SpaceRefusal | null {
  if (!access.signedIn) return "signed_out";
  if (access.transfers === false) return "no_transfers";
  if (direction === "to_workspace" && access.role !== null && !roleCan(access.role, "write")) return "viewer";
  if (direction === "from_workspace" && access.exportRestricted) return "export_restricted";
  return null;
}

/** The drop rules' view of a workspace in the directory. */
export function workspaceAccess(directory: ServerDirectory, server: string, workspace: string): WorkspaceAccess {
  const state = directory.getState();
  const entry = state.servers.find((s) => s.info.id === server);
  const ws = entry?.workspaces?.find((w) => w.id === workspace);
  const capabilities = state.capabilities[server];
  return {
    name: ws?.name ?? workspace,
    serverName: entry?.info.label ?? server,
    role: ws?.role ?? null,
    signedIn: entry !== undefined && entry.info.auth !== "signed-out",
    transfers: capabilities ? capabilities.includes("transfers") : null,
    exportRestricted: ws?.exportRestricted ?? false,
  };
}

/** Why a drop from the workspace `source` onto the workspace `destination` is refused, and which end says so; or null. */
export function betweenRefusal(source: WorkspaceAccess, destination: WorkspaceAccess): { refusal: SpaceRefusal; access: WorkspaceAccess } | null {
  const to = spaceDropRefusal("to_workspace", destination);
  if (to) return { refusal: to, access: destination };
  const from = spaceDropRefusal("from_workspace", source);
  return from ? { refusal: from, access: source } : null;
}

/** What the pointer says over a place that refuses the drop. */
export function refusalText(refusal: SpaceRefusal, access: WorkspaceAccess, s: Strings["tree"]["across"]): string {
  switch (refusal) {
    case "signed_out":
      return s.signedOut(access.serverName);
    case "no_transfers":
      return s.noTransfers(access.serverName);
    case "viewer":
      return s.viewer(access.name);
    case "export_restricted":
      return s.exportRestricted(access.name);
  }
}

/** Move, or Copy while Alt/Option is held (0.2.7; it was the other way round before). */
export const modeAtDrop = (event: { altKey: boolean }): "copy" | "move" => (event.altKey ? "copy" : "move");

export function encodeSpaceDrag(drag: SpaceDrag): string {
  return JSON.stringify(drag);
}

const isString = (v: unknown): v is string => typeof v === "string";

/** The drag in `text`, or null when it is not a page drag. */
export function decodeSpaceDrag(text: string): SpaceDrag | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const from = v.from as Record<string, unknown> | undefined;
  let space: Space;
  if (from?.kind === "private") space = { kind: "private" };
  else if (from?.kind === "workspace" && isString(from.server) && isString(from.workspace)) space = { kind: "workspace", server: from.server, workspace: from.workspace };
  else return null;
  if (!isString(v.row) || !isString(v.title) || !Array.isArray(v.ids) || v.ids.length === 0 || !v.ids.every(isString)) return null;
  if (v.base !== undefined && !isString(v.base)) return null;
  return { from: space, row: v.row, ids: [...v.ids], title: v.title, ...(isString(v.base) ? { base: v.base } : {}) };
}

// ------------------------------------------------------------------ the drag under way

let drag: SpaceDrag | null = null;
const dragListeners = new Set<() => void>();
const emitDrag = () => {
  for (const l of [...dragListeners]) l();
};

/** A tree started dragging pages that may go to the other space. */
export function beginSpaceDrag(next: SpaceDrag): void {
  drag = next;
  hover = null;
  emitDrag();
  emitHover();
  // The source row can be gone by the end of the drag (its tree re-rendered), and then its dragend never reaches
  // React. Any drop or dragend anywhere in the window ends the drag too.
  if (typeof window !== "undefined") {
    window.addEventListener("drop", endLater, { capture: true, once: true });
    window.addEventListener("dragend", endLater, { capture: true, once: true });
  }
}

/** After the target's own drop handler (a capture listener runs before it). */
const endLater = () => setTimeout(endSpaceDrag, 0);

export function endSpaceDrag(): void {
  if (typeof window !== "undefined") {
    window.removeEventListener("drop", endLater, { capture: true });
    window.removeEventListener("dragend", endLater, { capture: true });
  }
  if (drag === null && hover === null) return;
  drag = null;
  hover = null;
  emitDrag();
  emitHover();
}

export function currentSpaceDrag(): SpaceDrag | null {
  return drag;
}

const subscribeDrag = (listener: () => void) => {
  dragListeners.add(listener);
  return () => void dragListeners.delete(listener);
};

/** The drag under way, if any (changes only when a drag starts or ends). */
export function useSpaceDrag(): SpaceDrag | null {
  return useSyncExternalStore(subscribeDrag, currentSpaceDrag, currentSpaceDrag);
}

// ------------------------------------------------------------------ what the pointer is over

export interface SpaceHover {
  /** Who set it (a row of a tree, the Private Space header): only its own leave clears it. */
  owner: string;
  /** Pointer position in the window, for the badge. */
  x: number;
  y: number;
  /** "Copy to Studio…", or why not ("You are a viewer in Studio"). */
  text: string;
  /** Null when the drop is refused. */
  to: SpaceDestination | null;
}

let hover: SpaceHover | null = null;
const hoverListeners = new Set<() => void>();
const emitHover = () => {
  for (const l of [...hoverListeners]) l();
};

export function setSpaceHover(next: SpaceHover): void {
  if (hover && hover.owner === next.owner && hover.x === next.x && hover.y === next.y && hover.text === next.text && sameDestination(hover.to, next.to)) return;
  hover = next;
  emitHover();
}

export function clearSpaceHover(owner?: string): void {
  if (hover === null || (owner !== undefined && hover.owner !== owner)) return;
  hover = null;
  emitHover();
}

export function currentSpaceHover(): SpaceHover | null {
  return hover;
}

const subscribeHover = (listener: () => void) => {
  hoverListeners.add(listener);
  return () => void hoverListeners.delete(listener);
};

/** What the pointer is over during a drag across spaces (changes with every pointer move: keep its readers small). */
export function useSpaceHover(): SpaceHover | null {
  return useSyncExternalStore(subscribeHover, currentSpaceHover, currentSpaceHover);
}

/** Whether the drop would land at `to` right now (for a target that is not a tree row, such as the Private Space header). */
/** Which place holds the pointer's drop now (its `owner`), or null; changes only when that place does. */
export function useSpaceHoverOwner(): string | null {
  const read = () => hover?.owner ?? null;
  return useSyncExternalStore(subscribeHover, read, read);
}

export function useSpaceHoverAt(matches: (to: SpaceDestination) => boolean): boolean {
  const read = () => {
    const h = hover;
    return h !== null && h.to !== null && matches(h.to);
  };
  return useSyncExternalStore(subscribeHover, read, read);
}

export function sameDestination(a: SpaceDestination | null, b: SpaceDestination | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "private" || b.kind === "private") return a.kind === b.kind && (a as { folder: string }).folder === (b as { folder: string }).folder;
  return a.server === b.server && a.workspace === b.workspace && a.parentId === b.parentId;
}

// ------------------------------------------------------------------ the drop

const dropListeners = new Set<(drop: SpaceDrop) => void>();

/** Called for every drop across spaces; returns the unsubscribe. */
export function onSpaceDrop(listener: (drop: SpaceDrop) => void): () => void {
  dropListeners.add(listener);
  return () => void dropListeners.delete(listener);
}

export function dropAcrossSpaces(drop: SpaceDrop): void {
  endSpaceDrag();
  for (const l of [...dropListeners]) l(drop);
}
