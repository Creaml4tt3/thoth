/**
 * The floating toolbar on selected text in Blocks mode (ADR-0016 rule 1), and
 * the shortcuts for the same styles.
 *
 * Plain DOM, like the block menu. A WAI-ARIA toolbar (`role=toolbar`, roving
 * tabindex, Arrow/Home/End) of buttons with `aria-label` and `aria-pressed`:
 * bold, italic, underline, strikethrough, inline code, link, text colour and
 * highlight. Text colour opens a menu of the eight palette colours plus
 * "default"; link opens an address field in place of the buttons.
 *
 * Mouse use never moves focus out of the editor (buttons cancel `mousedown`).
 * From the keyboard, Alt+F10 (or Mod+Alt+T) moves focus into the toolbar,
 * Mod+Shift+K opens the link field, and Escape or Tab returns to the text.
 * It is hidden while the mouse is still selecting, for a caret, for a node
 * selection, in code blocks and when the selection holds raw or atom blocks.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { TEXT_COLORS, type TextColor } from "@thoth/editor";
import type { EditorStrings } from "../strings/en.ts";
import {
  MARK_STYLES,
  STYLE_SHORTCUTS,
  activeLinkHref,
  activeTextColor,
  isStyleActive,
  normalizeHref,
  runEdit,
  setLink,
  setTextColor,
  shortcutLabel,
  toggleStyle,
  toolbarApplies,
  type MarkStyle,
} from "./text-styles.ts";

const key = new PluginKey("thothTextToolbar");

/** What the keyboard shortcuts need from the toolbar of the open editor. */
export interface TextToolbarApi {
  /** Shows the link field for the selection; false when the selection cannot be linked. */
  openLink(): boolean;
  /** Moves focus into the toolbar; false when it is not showing. */
  focus(): boolean;
}

type Tool = MarkStyle | "link" | "color";
const TOOLS: readonly Tool[] = ["bold", "italic", "underline", "strike", "inlineCode", "link", "color", "highlight"];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

interface Toolbar extends TextToolbarApi {
  update(): void;
  /** The editor lost focus. */
  blurred(): void;
  mouseDown(): void;
  destroy(): void;
}

function createToolbar(view: EditorView, strings: EditorStrings): Toolbar {
  const t = strings.styles;
  const root = el("div", "text-toolbar");
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", t.toolbar);
  root.setAttribute("aria-orientation", "horizontal");
  root.hidden = true;

  const row = el("div", "text-toolbar-row");
  const form = el("form", "text-toolbar-link");
  form.hidden = true;
  form.noValidate = true;
  const menu = el("div", "text-color-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t.colorMenu);
  menu.hidden = true;
  root.append(row, form, menu);
  // Inside the themed element (`data-theme`): the tokens resolve per theme where they are declared. When the theme
  // is on <html> (applyTheme), the body inherits it, and the toolbar must stay inside the body.
  const themed = view.dom.closest<HTMLElement>("[data-theme]");
  (themed && themed !== document.documentElement ? themed : document.body).append(root);

  // Buttons ---------------------------------------------------------------
  const labels: Record<Tool, string> = { bold: t.bold, italic: t.italic, underline: t.underline, strike: t.strike, inlineCode: t.code, link: t.link, color: t.color, highlight: t.highlight };
  const buttons = new Map<Tool, HTMLButtonElement>();
  const glyphs: Record<Tool, string> = { bold: "B", italic: "I", underline: "U", strike: "S", inlineCode: "</>", link: t.link, color: "A", highlight: "H" };

  for (const tool of TOOLS) {
    const b = el("button", `text-tool text-tool-${tool}`);
    b.type = "button";
    b.tabIndex = -1;
    b.dataset["tool"] = tool;
    b.setAttribute("aria-label", labels[tool]);
    const shortcut = tool === "color" ? undefined : STYLE_SHORTCUTS[tool][0];
    b.title = shortcut ? t.withShortcut(labels[tool], shortcutLabel(shortcut)) : labels[tool];
    const glyph = el("span", "text-tool-glyph");
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = glyphs[tool];
    b.append(glyph);
    if (tool === "color") {
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
    } else b.setAttribute("aria-pressed", "false");
    buttons.set(tool, b);
    row.append(b);
  }
  buttons.get("bold")!.tabIndex = 0;
  const list = [...buttons.values()];

  const focusButton = (b: HTMLElement | undefined) => {
    if (!b) return;
    for (const other of list) other.tabIndex = other === b ? 0 : -1;
    b.focus();
  };
  const toEditor = () => view.focus();

  // Link field ------------------------------------------------------------
  const input = el("input", "text-toolbar-input");
  input.type = "text";
  input.setAttribute("aria-label", t.linkAddress);
  input.placeholder = t.linkPlaceholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  const apply = el("button", "text-toolbar-apply");
  apply.type = "submit";
  apply.textContent = t.linkApply;
  const remove = el("button", "text-toolbar-remove");
  remove.type = "button";
  remove.textContent = t.linkRemove;
  const problem = el("span", "text-toolbar-error");
  problem.setAttribute("role", "alert");
  form.append(input, apply, remove, problem);

  const formOpen = () => !form.hidden;
  const closeForm = () => {
    form.hidden = true;
    row.hidden = false;
    problem.textContent = "";
    input.removeAttribute("aria-invalid");
  };
  const openForm = () => {
    closeMenu();
    const href = activeLinkHref(view.state);
    input.value = href ?? "";
    remove.hidden = !isStyleActive(view.state, "link");
    problem.textContent = "";
    row.hidden = true;
    form.hidden = false;
    place();
    input.focus();
    input.select();
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const href = normalizeHref(input.value);
    if (href === null) {
      problem.textContent = t.linkInvalid;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    runEdit(view, setLink(href === "" ? null : href));
    closeForm();
    toEditor();
  });
  remove.addEventListener("click", () => {
    runEdit(view, setLink(null));
    closeForm();
    toEditor();
  });
  input.addEventListener("input", () => {
    problem.textContent = "";
    input.removeAttribute("aria-invalid");
  });

  // Colour menu -----------------------------------------------------------
  const menuItems = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const focusItem = (item: HTMLElement | undefined) => {
    if (!item) return;
    for (const other of menuItems()) other.tabIndex = other === item ? 0 : -1;
    item.focus();
  };
  const menuOpen = () => !menu.hidden;
  function closeMenu(): void {
    menu.hidden = true;
    buttons.get("color")?.setAttribute("aria-expanded", "false");
  }
  const pickColor = (color: TextColor | null) => {
    runEdit(view, setTextColor(color));
    closeMenu();
    toEditor();
  };
  function openMenu(focus: boolean): void {
    const current = activeTextColor(view.state);
    const choices: (TextColor | null)[] = [null, ...TEXT_COLORS];
    menu.replaceChildren(
      ...choices.map((color) => {
        const item = el("div", "text-color-item");
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(color === current));
        item.tabIndex = -1;
        const sample = el("span", "text-color-sample");
        sample.setAttribute("aria-hidden", "true");
        sample.textContent = "A";
        if (color) {
          sample.classList.add("text-color");
          sample.dataset["color"] = color;
        }
        const name = el("span", "text-color-name");
        name.textContent = t.colorNames[color ?? "default"];
        item.append(sample, name);
        item.addEventListener("mousedown", (event) => event.preventDefault());
        item.addEventListener("click", () => pickColor(color));
        return item;
      }),
    );
    menu.hidden = false;
    buttons.get("color")!.setAttribute("aria-expanded", "true");
    const trigger = buttons.get("color")!;
    menu.style.left = `${trigger.offsetLeft}px`;
    if (focus) focusItem(menuItems().find((i) => i.getAttribute("aria-checked") === "true") ?? menuItems()[0]);
  }

  // Actions ---------------------------------------------------------------
  buttons.forEach((b, tool) => {
    // No focus change on mouse down: the selection stays in the editor.
    b.addEventListener("mousedown", (event) => event.preventDefault());
    b.addEventListener("click", () => {
      if (tool === "color") return menuOpen() ? closeMenu() : openMenu(true);
      if (tool === "link") return openForm();
      runEdit(view, toggleStyle(tool));
    });
  });

  root.addEventListener("mousedown", (event) => {
    // The address field needs the caret; everything else keeps focus where it is.
    if (event.target !== input) event.preventDefault();
  });

  root.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      stop();
      if (menuOpen()) {
        closeMenu();
        focusButton(buttons.get("color"));
      } else {
        closeForm();
        toEditor();
      }
      return;
    }
    if (formOpen()) return; // Tab, arrows and Enter belong to the field and its buttons.
    if (menuOpen() && menu.contains(target)) {
      const items = menuItems();
      const at = items.indexOf(target);
      const go = (i: number) => {
        stop();
        focusItem(items[(i + items.length) % items.length]);
      };
      if (event.key === "ArrowDown") return go(at + 1);
      if (event.key === "ArrowUp") return go(at < 0 ? items.length - 1 : at - 1);
      if (event.key === "Home") return go(0);
      if (event.key === "End") return go(items.length - 1);
      if (event.key === "Enter" || event.key === " ") {
        stop();
        target.click();
        return;
      }
      if (event.key === "Tab") {
        stop();
        closeMenu();
        toEditor();
      }
      return;
    }
    const at = list.indexOf(target as HTMLButtonElement);
    if (at < 0) return;
    const go = (i: number) => {
      stop();
      focusButton(list[(i + list.length) % list.length]);
    };
    switch (event.key) {
      case "ArrowRight":
        return go(at + 1);
      case "ArrowLeft":
        return go(at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(list.length - 1);
      case "ArrowDown":
        if (target === buttons.get("color")) {
          stop();
          openMenu(true);
        }
        return;
      case "Tab":
        stop();
        closeMenu();
        toEditor();
    }
  });

  // Showing and placing ---------------------------------------------------
  let selecting = false;

  function place(): void {
    let start = { left: 0, top: 0, bottom: 0 };
    let end = start;
    try {
      const { from, to } = view.state.selection;
      start = view.coordsAtPos(from);
      end = view.coordsAtPos(to);
    } catch {
      // No layout (tests): the toolbar stays where it was.
    }
    const width = root.offsetWidth || 320;
    const height = root.offsetHeight || 40;
    root.style.left = `${Math.max(8, Math.min(start.left, window.innerWidth - width - 8))}px`;
    const above = start.top - height - 8;
    root.style.top = `${above >= 8 ? above : Math.min(end.bottom + 8, Math.max(8, window.innerHeight - height - 8))}px`;
  }

  function paint(state: EditorState): void {
    for (const [tool, b] of buttons) {
      if (tool === "color") {
        const color = activeTextColor(state);
        if (color) b.dataset["color"] = color;
        else delete b.dataset["color"];
      } else b.setAttribute("aria-pressed", String(isStyleActive(state, tool)));
    }
  }

  const hasFocus = () => view.hasFocus() || root.contains(document.activeElement);

  function hide(): void {
    closeMenu();
    closeForm();
    root.hidden = true;
  }

  function update(): void {
    if (selecting || !view.editable || !toolbarApplies(view.state)) return hide();
    // While focus moves (editor to toolbar, or away) `activeElement` is briefly the body: decide once it has landed.
    if (!hasFocus()) return hideIfFocusLeft();
    paint(view.state);
    root.hidden = false;
    place();
  }

  const reposition = () => {
    if (!root.hidden) place();
  };
  const mouseUp = () => {
    if (!selecting) return;
    selecting = false;
    update();
  };
  // Focus left the text or the toolbar: hide unless it went to the other one. `relatedTarget` is not reliable
  // (null in some browsers and in jsdom), so look at where focus is once the move has finished.
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const hideIfFocusLeft = () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (!hasFocus()) hide();
    }, 0);
  };
  root.addEventListener("focusout", hideIfFocusLeft);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  document.addEventListener("mouseup", mouseUp, true);

  return {
    update,
    blurred: hideIfFocusLeft,
    mouseDown() {
      selecting = true;
      hide();
    },
    openLink() {
      if (!view.editable || !toolbarApplies(view.state)) return false;
      root.hidden = false;
      paint(view.state);
      openForm();
      return true;
    },
    focus() {
      if (root.hidden) return false;
      closeMenu();
      focusButton(list.find((b) => b.getAttribute("aria-pressed") === "true") ?? buttons.get("bold"));
      return true;
    },
    destroy() {
      clearTimeout(focusTimer);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mouseup", mouseUp, true);
      root.remove();
    },
  };
}

/** Shortcuts and the floating toolbar for the text styles. */
export function textStylesExtension(strings: EditorStrings) {
  return Extension.create({
    name: "thothTextStyles",
    addStorage() {
      return { toolbar: null as TextToolbarApi | null };
    },
    addKeyboardShortcuts() {
      const storage = this.storage;
      const bindings: Record<string, () => boolean> = {};
      // A style shortcut always swallows the key: where it cannot apply (a code block), the browser's own bold would be worse.
      for (const style of MARK_STYLES) {
        for (const shortcut of STYLE_SHORTCUTS[style]) {
          bindings[shortcut] = () => {
            if (this.editor.isEditable) runEdit(this.editor.view, toggleStyle(style));
            return true;
          };
        }
      }
      for (const shortcut of STYLE_SHORTCUTS.link) {
        bindings[shortcut] = () => {
          if (this.editor.isEditable) storage.toolbar?.openLink();
          return true;
        };
      }
      for (const shortcut of STYLE_SHORTCUTS.toolbar) bindings[shortcut] = () => storage.toolbar?.focus() ?? false;
      return bindings;
    },
    addProseMirrorPlugins() {
      const storage = this.storage;
      let toolbar: Toolbar | null = null;
      return [
        new Plugin({
          key,
          view(view) {
            toolbar = createToolbar(view, strings);
            storage.toolbar = toolbar;
            return {
              update: () => toolbar?.update(),
              destroy() {
                toolbar?.destroy();
                toolbar = null;
                storage.toolbar = null;
              },
            };
          },
          props: {
            handleDOMEvents: {
              focus: () => (toolbar?.update(), false),
              blur: () => (toolbar?.blurred(), false),
              mousedown: () => (toolbar?.mouseDown(), false),
            },
          },
        }),
      ];
    },
  });
}
