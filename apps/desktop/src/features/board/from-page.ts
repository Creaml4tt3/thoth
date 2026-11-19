/**
 * "Board from this page" (ADR-0056): a new board `<page folder>/<page name>.canvas` ("… 2", "… 3" when taken) with the
 * page pinned in the middle and every page it links to or from pinned in a ring around it.
 */
import { basename, dirname, stripExtension } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import { NOTE_H, NOTE_W } from "@thoth/app-ui/board/BoardView.tsx";
import { newNodeId, type CanvasNode } from "@thoth/app-ui/board/canvas.ts";
import type { TabsController } from "@thoth/app-ui/tabs/useTabs.ts";
import { RenameError } from "../shell/rename.ts";
import { boardStore } from "./board-store.ts";

const RING = 260;
/** Room for one note on the ring, so many neighbours widen it instead of overlapping. */
const SLOT = 190;

export async function boardFromPage(vault: Vault, page: string): Promise<string> {
  const store = boardStore(vault);
  const name = stripExtension(basename(page));
  let path: string | null = null;
  for (let n = 1; path === null; n++) {
    try {
      path = await store.create(dirname(page), n === 1 ? name : `${name} ${n}`);
    } catch (error) {
      if (!(error instanceof RenameError) || error.problem !== "exists" || n >= 100) throw error;
    }
  }
  const { links } = await vault.graph();
  const around = [...new Set(links.flatMap((l) => (l.from === page ? [l.to] : l.to === page ? [l.from] : [])))].filter((p) => p !== page).sort();
  // Positions are note centres here; the file keeps top-left corners.
  const note = (file: string, x: number, y: number): CanvasNode => ({ id: newNodeId(), type: "file", file, x: Math.round(x - NOTE_W / 2), y: Math.round(y - NOTE_H / 2), width: NOTE_W, height: NOTE_H });
  const r = Math.max(RING, (around.length * SLOT) / (2 * Math.PI));
  const nodes = [
    note(page, 0, 0),
    ...around.map((file, i) => {
      const a = (2 * Math.PI * i) / around.length - Math.PI / 2;
      return note(file, r * Math.cos(a), r * Math.sin(a));
    }),
  ];
  await store.save(path, await store.read(path), nodes.map((node) => ({ kind: "pin" as const, node })));
  return path;
}

/** Makes the board, shows it in the sidebar and opens it. */
export async function openBoardFromPage(session: { vault: Vault; refresh(changed?: readonly string[]): Promise<void>; tabs: Pick<TabsController, "open"> }, page: string): Promise<void> {
  const path = await boardFromPage(session.vault, page);
  await session.refresh([path]);
  session.tabs.open({ kind: "board", path });
}
