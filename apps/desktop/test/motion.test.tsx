// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TREE_MOTION_MAX, TreeMotionContext, TreeGroup } from "@thoth/app-ui/order/TreeGroup.tsx";
import { TabBar, type TabItem } from "@thoth/app-ui/tabs/TabBar.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { leaveAsGhost, motionMs, motionOff, usePresence, whenSettled } from "@thoth/app-ui/ui/presence.ts";
import { createThemeStore } from "@thoth/app-ui/ui/theme.ts";

/**
 * Exit motion (packages/app-ui/src/ui/presence.ts) in a DOM with no layout engine: `matchMedia` and `getComputedStyle` are stood in for, so a
 * test says how long the CSS would animate (or that the person asked for reduced motion) and the components follow.
 */
const realStyle = window.getComputedStyle.bind(window);
let reduced = false;

/** Makes motion available: `ms` is what the CSS "says" every element animates for. 0 puts it back to a bare DOM. */
function withMotion(ms: number): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
    const style = realStyle(el, pseudo);
    const fake: Record<string, string> = { animationName: "thoth-test", animationDuration: `${ms}ms`, animationDelay: "0s", transitionDuration: `${ms}ms`, transitionDelay: "0s" };
    return new Proxy(style, {
      get(target, key) {
        if (typeof key === "string" && key in fake) return fake[key];
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  });
}

/** What the browser sends when a transition or animation ends on `el`. */
function end(el: Element, type: "transitionend" | "animationend", seconds = 0.14): void {
  const event = Object.assign(new Event(type, { bubbles: true }), { elapsedTime: seconds });
  act(() => void el.dispatchEvent(event));
}

beforeEach(() => {
  reduced = false;
});
afterEach(() => {
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  document.documentElement.removeAttribute("data-theme");
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("motionOff", () => {
  it("is true where there is no way to ask (no matchMedia), so a bare DOM never waits", () => {
    expect(motionOff()).toBe(true);
  });
  it("follows prefers-reduced-motion", () => {
    withMotion(140);
    expect(motionOff()).toBe(false);
    reduced = true;
    expect(motionOff()).toBe(true);
  });
});

describe("motionMs", () => {
  it("reads the longest animation or transition, with its delay, from the computed style", () => {
    withMotion(140);
    expect(motionMs(document.body)).toEqual({ duration: 140, total: 140 });
  });
  it("is zero for an element that does not move", () => {
    expect(motionMs(document.body)).toEqual({ duration: 0, total: 0 });
  });
});

describe("whenSettled", () => {
  it("calls done at once when there is no motion", () => {
    const done = vi.fn();
    whenSettled(document.body, done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("waits for the element's own end event, not a child's, and not before the full time has passed", () => {
    withMotion(140);
    const el = document.createElement("div");
    const child = document.createElement("span");
    el.append(child);
    document.body.append(el);
    const done = vi.fn();
    whenSettled(el, done);
    expect(done).not.toHaveBeenCalled();
    end(child, "transitionend");
    end(el, "transitionend", 0.05); // a shorter transition on the same element
    expect(done).not.toHaveBeenCalled();
    end(el, "transitionend", 0.14);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("falls back to a timer when no end event comes, and only once", () => {
    vi.useFakeTimers();
    withMotion(140);
    const el = document.createElement("div");
    document.body.append(el);
    const done = vi.fn();
    whenSettled(el, done);
    vi.advanceTimersByTime(200);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(done).toHaveBeenCalledTimes(1);
    end(el, "animationend");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("does not call done after it is cancelled", () => {
    vi.useFakeTimers();
    withMotion(140);
    const el = document.createElement("div");
    document.body.append(el);
    const done = vi.fn();
    const cancel = whenSettled(el, done);
    cancel();
    vi.advanceTimersByTime(1000);
    end(el, "transitionend");
    expect(done).not.toHaveBeenCalled();
  });

  it("does not wait under reduced motion even when the CSS has a duration", () => {
    withMotion(140);
    reduced = true;
    const done = vi.fn();
    whenSettled(document.body, done);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

function Panel({ open, enabled }: { open: boolean; enabled?: boolean }) {
  const { present, state, ref } = usePresence<HTMLDivElement>(open, enabled);
  return present ? <div ref={ref} data-testid="panel" data-state={state} /> : null;
}

describe("usePresence", () => {
  it("mounted open, it is open at once and does not animate in", () => {
    withMotion(140);
    render(<Panel open />);
    expect(screen.getByTestId("panel").dataset["state"]).toBe("open");
  });

  it("closing keeps the element, as closed, until its transition has ended", () => {
    withMotion(140);
    const view = render(<Panel open />);
    view.rerender(<Panel open={false} />);
    expect(screen.getByTestId("panel").dataset["state"]).toBe("closed");
    end(screen.getByTestId("panel"), "transitionend");
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("opening later mounts it and ends up open", () => {
    withMotion(140);
    const view = render(<Panel open={false} />);
    expect(screen.queryByTestId("panel")).toBeNull();
    view.rerender(<Panel open />);
    expect(screen.getByTestId("panel").dataset["state"]).toBe("open");
  });

  it("opening again during the exit keeps the same element and cancels the removal", () => {
    vi.useFakeTimers();
    withMotion(140);
    const view = render(<Panel open />);
    const first = screen.getByTestId("panel");
    view.rerender(<Panel open={false} />);
    view.rerender(<Panel open />);
    expect(screen.getByTestId("panel")).toBe(first);
    expect(first.dataset["state"]).toBe("open");
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("panel")).toBe(first);
  });

  it("closing removes it at once when there is no motion, under reduced motion, or when disabled", () => {
    const view = render(<Panel open />);
    view.rerender(<Panel open={false} />);
    expect(screen.queryByTestId("panel")).toBeNull();

    withMotion(140);
    reduced = true;
    const again = render(<Panel open />);
    again.rerender(<Panel open={false} />);
    expect(screen.queryByTestId("panel")).toBeNull();

    reduced = false;
    const off = render(<Panel open enabled={false} />);
    off.rerender(<Panel open={false} enabled={false} />);
    expect(screen.queryByTestId("panel")).toBeNull();
  });
});

describe("leaveAsGhost", () => {
  function scrimWithModal(): HTMLElement {
    const scrim = document.createElement("div");
    scrim.id = "scrim-id";
    scrim.className = "modal-scrim";
    scrim.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Title</h2><button>Go</button></div>';
    document.body.append(scrim);
    return scrim;
  }
  const flush = () => act(async () => void (await Promise.resolve()));

  it("leaves an inert copy without ids, hidden from assistive technology, then removes it when the exit ends", async () => {
    withMotion(140);
    const scrim = scrimWithModal();
    leaveAsGhost(scrim, ".modal");
    scrim.remove();
    await flush();
    const ghost = document.querySelector<HTMLElement>('[data-state="closing"]')!;
    expect(ghost).toBeTruthy();
    expect(ghost.classList.contains("modal-scrim")).toBe(true);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.hasAttribute("inert")).toBe(true);
    expect(ghost.querySelectorAll("[id]")).toHaveLength(0);
    expect(ghost.hasAttribute("id")).toBe(false);
    // Nothing in the page can mistake it for an open dialog (the shortcuts wait while one is open).
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(ghost.querySelector("[role], [aria-modal], [aria-labelledby]")).toBeNull();
    end(ghost.querySelector(".modal")!, "animationend");
    expect(document.querySelector('[data-state="closing"]')).toBeNull();
  });

  it("leaves nothing when there is no motion, under reduced motion, or when the original is still in the page", async () => {
    const bare = scrimWithModal();
    leaveAsGhost(bare, ".modal");
    bare.remove();
    await flush();
    expect(document.querySelector('[data-state="closing"]')).toBeNull();

    withMotion(140);
    reduced = true;
    const calm = scrimWithModal();
    leaveAsGhost(calm, ".modal");
    calm.remove();
    await flush();
    expect(document.querySelector('[data-state="closing"]')).toBeNull();

    reduced = false;
    const alive = scrimWithModal();
    leaveAsGhost(alive, ".modal");
    await flush();
    expect(document.querySelector('[data-state="closing"]')).toBeNull();
  });
});

describe("Modal", () => {
  function Host({ show, onClose }: { show: boolean; onClose?: () => void }) {
    return (
      <>
        <button>opener</button>
        {show && (
          <Modal title="Rename" {...(onClose ? { onClose } : {})}>
            <input data-autofocus aria-label="Name" />
            <button>OK</button>
          </Modal>
        )}
      </>
    );
  }
  const flush = () => act(async () => void (await Promise.resolve()));

  it("traps focus: Tab from the last control goes to the first, Shift+Tab the other way", () => {
    withMotion(140);
    render(<Host show onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: "Rename" });
    const buttons = dialog.querySelectorAll("button");
    const last = buttons[buttons.length - 1]!;
    const first = dialog.querySelector<HTMLElement>("button, input")!;
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("gives focus back at once when it goes, and plays its exit on an inert copy that nothing can reach", async () => {
    withMotion(140);
    const view = render(<Host show={false} />);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    view.rerender(<Host show onClose={() => undefined} />);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })); // the dialog took focus
    view.rerender(<Host show={false} />);
    await flush();
    const ghost = document.querySelector<HTMLElement>('.modal-scrim[data-state="closing"]')!;
    expect(ghost).toBeTruthy();
    expect(ghost.hasAttribute("inert")).toBe(true);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull(); // no second dialog for assistive technology
    expect(ghost.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(opener);
    end(ghost.querySelector(".modal")!, "animationend");
    expect(document.querySelector('[data-state="closing"]')).toBeNull();
  });

  it("goes at once, with no copy, when motion is off", async () => {
    const view = render(<Host show onClose={() => undefined} />);
    view.rerender(<Host show={false} />);
    await flush();
    expect(document.querySelector(".modal-scrim")).toBeNull();
  });
});

describe("TreeGroup", () => {
  function Tree({ open, count = 2, touched = true }: { open: boolean; count?: number; touched?: boolean }) {
    return (
      <TreeMotionContext value={touched}>
        <ul role="tree" aria-label="Pages">
          <li role="none">
            <button role="treeitem" aria-expanded={open}>
              Folder
            </button>
            <TreeGroup open={open} count={count}>
              <li role="none">
                <button role="treeitem">Child</button>
              </li>
            </TreeGroup>
          </li>
        </ul>
      </TreeMotionContext>
    );
  }

  it("is open without any motion on the first render", () => {
    withMotion(140);
    render(<Tree open />);
    const group = screen.getByRole("group");
    expect(group.parentElement!.dataset["state"]).toBe("open");
    expect(group.hasAttribute("inert")).toBe(false);
  });

  it("while it closes, the rows are inert and hidden from the keyboard and assistive technology, then it is removed", () => {
    withMotion(140);
    const view = render(<Tree open />);
    view.rerender(<Tree open={false} />);
    expect(screen.queryByRole("group")).toBeNull(); // not exposed to assistive technology
    const group = document.querySelector<HTMLElement>('[role="group"]')!;
    expect(group.hasAttribute("inert")).toBe(true);
    expect(group.getAttribute("aria-hidden")).toBe("true");
    expect(group.parentElement!.dataset["state"]).toBe("closed");
    end(group.parentElement!, "transitionend");
    expect(document.querySelector('[role="group"]')).toBeNull();
  });

  it("moves focus from a row inside to the folder's own row before it goes", () => {
    withMotion(140);
    const view = render(<Tree open />);
    screen.getByRole("treeitem", { name: "Child" }).focus();
    view.rerender(<Tree open={false} />);
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Folder" }));
  });

  it("does not animate a long folder, a tree nobody has used yet, or anything under reduced motion", () => {
    withMotion(140);
    const long = render(<Tree open count={TREE_MOTION_MAX + 1} />);
    long.rerender(<Tree open={false} count={TREE_MOTION_MAX + 1} />);
    expect(document.querySelector('[role="group"]')).toBeNull();
    long.unmount();

    const fresh = render(<Tree open touched={false} />);
    fresh.rerender(<Tree open={false} touched={false} />);
    expect(document.querySelector('[role="group"]')).toBeNull();
    fresh.unmount();

    reduced = true;
    const calm = render(<Tree open />);
    calm.rerender(<Tree open={false} />);
    expect(document.querySelector('[role="group"]')).toBeNull();
  });
});

describe("TabBar", () => {
  const tabs = (...names: string[]): TabItem[] => names.map((n) => ({ id: n, label: n }));
  const bar = (items: TabItem[], active = items[0]?.id ?? "") => <TabBar tabs={items} active={active} onActivate={() => undefined} onClose={() => undefined} onNew={() => undefined} />;

  it("tabs that are there from the start do not animate in", () => {
    withMotion(140);
    render(bar(tabs("a", "b")));
    expect(document.querySelectorAll("[data-enter]")).toHaveLength(0);
  });

  it("a tab opened later enters; the others do not", () => {
    withMotion(140);
    const view = render(bar(tabs("a", "b")));
    view.rerender(bar(tabs("a", "b", "c"), "c"));
    const entering = [...document.querySelectorAll("[data-enter]")].map((el) => el.textContent);
    expect(entering).toEqual(["c"]);
  });

  it("a closed tab stays as an inert picture where it was, out of the tab list, then goes", () => {
    vi.useFakeTimers();
    withMotion(140);
    const view = render(bar(tabs("a", "b", "c"), "b"));
    view.rerender(bar(tabs("a", "c"), "c"));
    const ghost = document.querySelector<HTMLElement>("[data-leaving]")!;
    expect(ghost).toBeTruthy();
    expect(ghost.textContent).toBe("b");
    expect(ghost.hasAttribute("inert")).toBe(true);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.dataset["selected"]).toBeDefined(); // it still looks like the tab it was
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["a", "c"]);
    expect([...document.querySelectorAll(".tab")].map((t) => t.textContent)).toEqual(["a", "b", "c"]); // in place
    act(() => void vi.advanceTimersByTime(500));
    expect(document.querySelector("[data-leaving]")).toBeNull();
  });

  it("closes at once when there is no motion", () => {
    const view = render(bar(tabs("a", "b")));
    view.rerender(bar(tabs("a")));
    expect(document.querySelector("[data-leaving]")).toBeNull();
    expect(document.querySelectorAll(".tab")).toHaveLength(1);
  });

  it("keeps keyboard focus handling on the open tabs only", () => {
    withMotion(140);
    const onClose = vi.fn();
    const view = render(<TabBar tabs={tabs("a", "b", "c")} active="a" onActivate={() => undefined} onClose={onClose} onNew={() => undefined} />);
    view.rerender(<TabBar tabs={tabs("a", "c")} active="a" onActivate={() => undefined} onClose={onClose} onNew={() => undefined} />);
    const first = screen.getAllByRole("tab")[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getAllByRole("tab")[1]);
    expect(document.activeElement?.textContent).toBe("c"); // the closing "b" is skipped
  });
});

describe("theme change", () => {
  const storage = { read: () => "light", write: () => undefined };
  const fakeTransition = () => vi.fn((update: () => void) => (update(), { ready: Promise.resolve(), finished: Promise.resolve() }));

  it("dissolves inside a view transition when the browser has them, and applies the saved theme at load without one", () => {
    withMotion(140);
    const start = fakeTransition();
    Object.assign(document, { startViewTransition: start });
    const store = createThemeStore(storage);
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    store.set("dark");
    expect(start).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
  });

  it("just changes where there is no View Transitions API, or under reduced motion, or no layout", () => {
    withMotion(140);
    createThemeStore(storage).set("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");

    const start = fakeTransition();
    Object.assign(document, { startViewTransition: start });
    reduced = true;
    createThemeStore(storage).set("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    vi.unstubAllGlobals(); // no matchMedia at all
    createThemeStore(storage).set("dark");
    expect(start).not.toHaveBeenCalled();
  });

  it("a fake root (the tests of the store) is changed at once and never put in a transition", () => {
    withMotion(140);
    const start = fakeTransition();
    Object.assign(document, { startViewTransition: start });
    const attributes: string[] = [];
    createThemeStore(storage, { setAttribute: (_name, value) => void attributes.push(value) }).set("dark");
    expect(attributes).toEqual(["light", "night"]);
    expect(start).not.toHaveBeenCalled();
  });
});
