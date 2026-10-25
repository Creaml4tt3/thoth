// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTreeDnd, type DropZone } from "../src/order/dnd.ts";

afterEach(() => {
  cleanup();
  document.querySelectorAll(".tree-drag-image").forEach((n) => n.remove()); // pictures of earlier tests, waiting for their timer
});

const TOP = "top";
/** Folder "dir" is open with first child "dir/a"; "dir/a" and "b" are pages; the top strip takes drops only inside. */
function Tree({ drops, open = true }: { drops: [string, string, DropZone][]; open?: boolean }) {
  const dnd = useTreeDnd({
    enabled: true,
    canContain: (id) => id === "dir",
    canOrder: true,
    onlyInside: (id) => id === TOP,
    firstChild: (id) => (id === "dir" && open ? "dir/a" : null),
    canDrop: (drag, over) => drag !== over,
    onDrop: (d, o, z) => void drops.push([d, o, z]),
  });
  return (
    <div>
      {["dir", "dir/a", "b", TOP].map((id) => (
        <button key={id} data-testid={id} {...(id === TOP ? { ...dnd.rowProps(id), draggable: undefined } : dnd.rowProps(id))}>
          <span className="tree-label">{id}</span>
        </button>
      ))}
    </div>
  );
}

const data = { setData: () => undefined, getData: () => "", effectAllowed: "", dropEffect: "", setDragImage: vi.fn() };
function at(target: HTMLElement, type: "dragOver" | "dragEnter" | "drop" | "dragLeave", fraction: number, extra: object = {}) {
  target.getBoundingClientRect = () => ({ top: 0, height: 100, left: 0, width: 200, bottom: 100, right: 200, x: 0, y: 0, toJSON: () => ({}) });
  const event = createEvent[type](target, { dataTransfer: data, ...extra });
  Object.defineProperty(event, "clientY", { value: fraction * 100 });
  Object.defineProperty(event, "clientX", { value: 100 });
  fireEvent(target, event);
  return event;
}

describe("useTreeDnd", () => {
  it("accepts a drop on dragenter as well as dragover (it cancels both)", () => {
    render(<Tree drops={[]} />);
    fireEvent.dragStart(screen.getByTestId("b"), { dataTransfer: data });
    expect(at(screen.getByTestId("dir/a"), "dragEnter", 0.2).defaultPrevented).toBe(true);
    expect(at(screen.getByTestId("dir/a"), "dragOver", 0.2).defaultPrevented).toBe(true);
    expect(screen.getByTestId("dir/a").getAttribute("data-drop")).toBe("before");
  });

  it("the lower edge of an open folder means before its first child, and is drawn there", () => {
    const drops: [string, string, DropZone][] = [];
    render(<Tree drops={drops} />);
    fireEvent.dragStart(screen.getByTestId("b"), { dataTransfer: data });
    at(screen.getByTestId("dir"), "dragOver", 0.95);
    expect(screen.getByTestId("dir").hasAttribute("data-drop")).toBe(false);
    expect(screen.getByTestId("dir/a").getAttribute("data-drop")).toBe("before");
    at(screen.getByTestId("dir"), "drop", 0.95);
    expect(drops).toEqual([["b", "dir/a", "before"]]);
  });

  it("the lower edge of a closed folder is still 'after' it", () => {
    const drops: [string, string, DropZone][] = [];
    render(<Tree drops={drops} open={false} />);
    fireEvent.dragStart(screen.getByTestId("b"), { dataTransfer: data });
    at(screen.getByTestId("dir"), "dragOver", 0.95);
    expect(screen.getByTestId("dir").getAttribute("data-drop")).toBe("after");
  });

  it("a row that is only a place to drop into is 'inside' over its whole height", () => {
    const drops: [string, string, DropZone][] = [];
    render(<Tree drops={drops} />);
    fireEvent.dragStart(screen.getByTestId("b"), { dataTransfer: data });
    for (const f of [0.05, 0.5, 0.95]) {
      at(screen.getByTestId(TOP), "dragOver", f);
      expect(screen.getByTestId(TOP).getAttribute("data-drop")).toBe("inside");
    }
  });

  it("does not flicker when the pointer is still over the row and the browser names no related target", () => {
    render(<Tree drops={[]} />);
    fireEvent.dragStart(screen.getByTestId("b"), { dataTransfer: data });
    at(screen.getByTestId("dir/a"), "dragOver", 0.2);
    at(screen.getByTestId("dir/a"), "dragLeave", 0.5, { relatedTarget: null }); // pointer inside the row's box
    expect(screen.getByTestId("dir/a").getAttribute("data-drop")).toBe("before");
    at(screen.getByTestId("dir/a"), "dragLeave", 1.4, { relatedTarget: null }); // really gone
    expect(screen.getByTestId("dir/a").hasAttribute("data-drop")).toBe(false);
  });

  it("marks the page while it drags, sets a small picture, and clears everything when it ends", async () => {
    vi.useFakeTimers();
    render(<Tree drops={[]} />);
    fireEvent.dragStart(screen.getByTestId("b"), { dataTransfer: data });
    expect(document.querySelector(".tree-drag-image")?.textContent).toBe("b");
    expect(data.setDragImage).toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(document.documentElement.hasAttribute("data-tree-dragging")).toBe(true);
    fireEvent.dragEnd(screen.getByTestId("b"), { dataTransfer: data });
    expect(document.documentElement.hasAttribute("data-tree-dragging")).toBe(false);
    expect(document.querySelector(".tree-drag-image")).toBeNull();
    vi.useRealTimers();
  });
});
