/**
 * The Board's file: JSON Canvas 1.0, read, merged and written as plain data. Other apps (Obsidian) write the same
 * file, so everything Thoth does not own (other node types, edges, unknown fields, key order) goes back unchanged.
 */
import { isMarkdownPath } from "@thoth/domain";

export interface CanvasFile {
  /** The parsed top-level object; `serializeCanvas` keeps its keys and their order. */
  raw: Record<string, unknown>;
  nodes: CanvasNode[];
  edges: unknown[];
}
export type CanvasNode = { id: string; type: string; x: number; y: number; width: number; height: number; file?: string; [k: string]: unknown };
export type BoardChange = { kind: "move"; id: string; x: number; y: number } | { kind: "pin"; node: CanvasNode } | { kind: "unpin"; id: string };

export class CanvasError extends Error {
  override name = "CanvasError";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Trust boundary: the file may come from any app, so the shape is checked before anything uses it. */
export function parseCanvas(text: string): CanvasFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CanvasError("The canvas is not valid JSON.");
  }
  if (!isObject(raw)) throw new CanvasError("The canvas is not a JSON object.");
  const { nodes = [], edges = [] } = raw;
  if (!Array.isArray(nodes)) throw new CanvasError("The canvas `nodes` is not a list.");
  if (!Array.isArray(edges)) throw new CanvasError("The canvas `edges` is not a list.");
  for (const n of nodes) {
    const ok =
      isObject(n) && typeof n.id === "string" && typeof n.type === "string" && ["x", "y", "width", "height"].every((k) => typeof n[k] === "number" && Number.isFinite(n[k]));
    if (!ok) throw new CanvasError("A canvas node has no id, type or position.");
  }
  return { raw, nodes: nodes as CanvasNode[], edges };
}

export function serializeCanvas(c: CanvasFile): string {
  // Keys keep their original order; nodes and edges are written where they were, or at the end if the file had none.
  const out: Record<string, unknown> = { ...c.raw };
  if ("nodes" in c.raw || c.nodes.length) out.nodes = c.nodes;
  if ("edges" in c.raw || c.edges.length) out.edges = c.edges;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Pure. A move or unpin of a node that is gone (another app deleted it) is dropped; a pin of an existing id is ignored. */
export function applyChanges(c: CanvasFile, changes: readonly BoardChange[]): CanvasFile {
  let nodes = c.nodes;
  for (const ch of changes) {
    if (ch.kind === "move") nodes = nodes.map((n) => (n.id === ch.id ? { ...n, x: Math.round(ch.x), y: Math.round(ch.y) } : n));
    else if (ch.kind === "unpin") nodes = nodes.filter((n) => n.id !== ch.id);
    else if (!nodes.some((n) => n.id === ch.node.id)) nodes = [...nodes, { ...ch.node, x: Math.round(ch.node.x), y: Math.round(ch.node.y) }];
  }
  return { ...c, nodes };
}

export function pinnedPaths(c: CanvasFile): string[] {
  const paths = c.nodes.flatMap((n) => (n.type === "file" && typeof n.file === "string" && isMarkdownPath(n.file) ? [n.file] : []));
  return [...new Set(paths)];
}

/** 16 hex characters, like Obsidian's. */
export function newNodeId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}
