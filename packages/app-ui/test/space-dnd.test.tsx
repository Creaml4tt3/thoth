// @vitest-environment jsdom
// useTreeDnd across two trees (ADR-0006, amendment of 2026-10-26): a row carries its pages to the other tree, which
// lights its target row and asks for a transfer at the drop; within one tree nothing changes.
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTreeDnd, type DropZone } from "../src/order/dnd.ts";
import { SPACE_DRAG_TYPE, currentSpaceDrag, currentSpaceHover, decodeSpaceDrag, endSpaceDrag, onSpaceDrop, type SpaceDrag, type SpaceDrop } from "../src/order/space-drag.ts";
import type { AcrossTarget } from "../src/order/dnd.ts";

afterEach(() => {
  cleanup();
  endSpaceDrag();
  document.querySelectorAll(".tree-drag-image").forEach((n) => n.remove());
});

const LOCAL = { kind: "private" } as const;
const REMOTE = { kind: "workspace", server: "s", workspace: "w" } as const;

/** The "local" tree carries its rows; the "remote" one takes them (except on "refuse", which says why not). */
function Trees({ drops, enabled = true }: { drops: [string, string, DropZone][]; enabled?: boolean }) {
  const local = useTreeDnd({
    enabled,
    canContain: () => false,
    canOrder: true,
    canDrop: (d, o) => d !== o,
    onDrop: (d, o, z) => void drops.push([d, o, z]),
    carry: (id): SpaceDrag => ({ from: LOCAL, row: id, ids: [id], title: id }),
  });
  const remote = useTreeDnd({
    enabled: false,
    canContain: () => true,
    canOrder: true,
    canDrop: () => true,
    onDrop: (d, o, z) => void drops.push([d, o, z]),
    across: (drag, id, move): AcrossTarget | null => {
      if (drag.from.kind !== "private") return null;
      if (id === "refuse") return { highlight: null, to: null, text: "You are a viewer in W" };
      return { highlight: id, to: { kind: "workspace", server: "s", workspace: "w", parentId: id === "top" ? null : id }, text: move ? "Move to W…" : "Copy to W…" };
    },
  });
  return (
    <div>
      {["a", "b"].map((id) => (
        <button key={id} data-testid={id} {...local.rowProps(id)}>
          <span className="tree-label">{id}</span>
        </button>
      ))}
      {["top", "p", "refuse"].map((id) => (
        <button key={id} data-testid={id} {...remote.rowProps(id)}>
          <span className="tree-label">{id}</span>
        </button>
      ))}
    </div>
  );
}

/** A second workspace's tree, where this person is a viewer: every drop is refused. */
function Other() {
  const tree = useTreeDnd({
    enabled: false,
    canContain: () => true,
    canOrder: true,
    canDrop: () => true,
    onDrop: () => undefined,
    across: (): AcrossTarget => ({ highlight: null, to: null, text: "You are a viewer in V" }),
  });
  return (
    <button data-testid="viewer" {...tree.rowProps("viewer")}>
      <span className="tree-label">viewer</span>
    </button>
  );
}

function transfer() {
  const store = new Map<string, string>();
  return { setData: vi.fn((type: string, value: string) => void store.set(type, value)), getData: (type: string) => store.get(type) ?? "", effectAllowed: "", dropEffect: "", setDragImage: vi.fn(), store };
}
function at(target: HTMLElement, type: "dragOver" | "dragEnter" | "drop" | "dragLeave", data: object, extra: { altKey?: boolean; fraction?: number } = {}) {
  target.getBoundingClientRect = () => ({ top: 0, height: 100, left: 0, width: 200, bottom: 100, right: 200, x: 0, y: 0, toJSON: () => ({}) });
  const event = createEvent[type](target, { dataTransfer: data });
  Object.defineProperty(event, "clientY", { value: (extra.fraction ?? 0.5) * 100 });
  Object.defineProperty(event, "clientX", { value: type === "dragLeave" ? 500 : 100 });
  Object.defineProperty(event, "altKey", { value: extra.altKey ?? false });
  fireEvent(target, event);
  return event;
}

describe("useTreeDnd across spaces", () => {
  it("dragstart publishes what the row carries, as shared state and as drag data, allowing copy or move", () => {
    render(<Trees drops={[]} />);
    const data = transfer();
    fireEvent.dragStart(screen.getByTestId("a"), { dataTransfer: data });
    expect(currentSpaceDrag()).toEqual({ from: LOCAL, row: "a", ids: ["a"], title: "a" });
    expect(decodeSpaceDrag(data.store.get(SPACE_DRAG_TYPE)!)).toEqual(currentSpaceDrag());
    expect(data.effectAllowed).toBe("copyMove");
    fireEvent.dragEnd(screen.getByTestId("a"), { dataTransfer: data });
    expect(currentSpaceDrag()).toBeNull();
  });

  it("the other tree lights the target row inside, accepts the drop as a move, and says so by the pointer", () => {
    render(<Trees drops={[]} />);
    const data = transfer();
    fireEvent.dragStart(screen.getByTestId("a"), { dataTransfer: data });
    const over = at(screen.getByTestId("p"), "dragOver", data);
    expect(over.defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("move");
    expect(screen.getByTestId("p").getAttribute("data-drop")).toBe("inside");
    expect(currentSpaceHover()).toMatchObject({ text: "Move to W…", to: { kind: "workspace", parentId: "p" } });
  });

  it("Alt/Option makes it a copy, at the hover and at the drop", () => {
    const drops: SpaceDrop[] = [];
    const off = onSpaceDrop((d) => drops.push(d));
    render(<Trees drops={[]} />);
    const data = transfer();
    fireEvent.dragStart(screen.getByTestId("b"), { dataTransfer: data });
    at(screen.getByTestId("top"), "dragOver", data, { altKey: true });
    expect(data.dropEffect).toBe("copy");
    expect(currentSpaceHover()?.text).toBe("Copy to W…");
    const drop = at(screen.getByTestId("top"), "drop", data, { altKey: true });
    off();
    expect(drop.defaultPrevented).toBe(true);
    expect(drops).toEqual([{ drag: { from: LOCAL, row: "b", ids: ["b"], title: "b" }, to: { kind: "workspace", server: "s", workspace: "w", parentId: null }, mode: "copy" }]);
    expect(screen.getByTestId("top").hasAttribute("data-drop")).toBe(false);
    expect(currentSpaceDrag()).toBeNull();
  });

  it("a refused row shows no indicator and does not accept the drop (the no-drop cursor), but says why", () => {
    const drops: SpaceDrop[] = [];
    const off = onSpaceDrop((d) => drops.push(d));
    render(<Trees drops={[]} />);
    const data = transfer();
    fireEvent.dragStart(screen.getByTestId("a"), { dataTransfer: data });
    expect(at(screen.getByTestId("refuse"), "dragOver", data).defaultPrevented).toBe(false);
    expect(document.querySelector("[data-drop]")).toBeNull();
    expect(currentSpaceHover()).toMatchObject({ text: "You are a viewer in W", to: null });
    at(screen.getByTestId("refuse"), "drop", data);
    off();
    expect(drops).toEqual([]);
  });

  it("a row lit in one workspace goes dark when the pointer is over another workspace, even if its leave was missed", () => {
    render(
      <>
        <Trees drops={[]} />
        <Other />
      </>,
    );
    const data = transfer();
    fireEvent.dragStart(screen.getByTestId("a"), { dataTransfer: data });
    at(screen.getByTestId("p"), "dragOver", data);
    expect(screen.getByTestId("p").getAttribute("data-drop")).toBe("inside");
    // No dragleave for p (the browser sent it with the pointer still inside, or not at all): the other workspace refuses.
    at(screen.getByTestId("viewer"), "dragOver", data);
    expect(document.querySelector("[data-drop]")).toBeNull();
    expect(currentSpaceHover()).toMatchObject({ text: "You are a viewer in V", to: null });
  });

  it("leaving the target row clears its light and the badge", () => {
    render(<Trees drops={[]} />);
    const data = transfer();
    fireEvent.dragStart(screen.getByTestId("a"), { dataTransfer: data });
    at(screen.getByTestId("p"), "dragOver", data);
    at(screen.getByTestId("p"), "dragLeave", data);
    expect(screen.getByTestId("p").hasAttribute("data-drop")).toBe(false);
    expect(currentSpaceHover()).toBeNull();
  });

  it("within the source tree a drag is the same as before: a move, no transfer", () => {
    const drops: [string, string, DropZone][] = [];
    const across: SpaceDrop[] = [];
    const off = onSpaceDrop((d) => across.push(d));
    render(<Trees drops={drops} />);
    const data = transfer();
    fireEvent.dragStart(screen.getByTestId("a"), { dataTransfer: data });
    at(screen.getByTestId("b"), "dragOver", data, { fraction: 0.8 });
    expect(data.dropEffect).toBe("move");
    expect(screen.getByTestId("b").getAttribute("data-drop")).toBe("after");
    at(screen.getByTestId("b"), "drop", data, { fraction: 0.8 });
    off();
    expect(drops).toEqual([["a", "b", "after"]]);
    expect(across).toEqual([]);
  });

  it("a tree that cannot reorder now (the Private Space while selecting) still lets its rows be carried, and never reorders them", () => {
    const drops: [string, string, DropZone][] = [];
    render(<Trees drops={drops} enabled={false} />);
    expect(screen.getByTestId("a").getAttribute("draggable")).toBe("true");
    const data = transfer();
    fireEvent.dragStart(screen.getByTestId("a"), { dataTransfer: data });
    expect(currentSpaceDrag()?.row).toBe("a");
    expect(at(screen.getByTestId("b"), "dragOver", data).defaultPrevented).toBe(false);
    at(screen.getByTestId("b"), "drop", data);
    expect(drops).toEqual([]);
  });
});
