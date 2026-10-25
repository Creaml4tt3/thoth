/**
 * What the rest of the window can ask of the mascot: open or close its prompt bubble, "ask" (the shortcut: the bubble,
 * or the review when one is waiting), and shrink or expand it. The mascot component registers how it does these; the
 * shell, the palette and the sidebar only call them. Its preferences live in a `MascotPrefsStore` next to it.
 */
import type { MascotVersion } from "./MascotArt.tsx";
import { createMascotPrefsStore, type MascotPrefsStore } from "./prefs.ts";

export interface AssistantView {
  bubble: boolean;
  /** Bumped whenever focus should go to the bubble's task field (it was asked for again while open). */
  focusNonce: number;
}

export interface AssistantController {
  prefs: MascotPrefsStore;
  subscribe(listener: () => void): () => void;
  get(): AssistantView;
  openBubble(): void;
  closeBubble(): void;
  /** The shortcut and the palette's "Ask Thoth": what a click on the mascot does. */
  ask(): void;
  /** Shrinks the full version, or expands the compact one (and remembers that size). */
  toggleSize(): void;
  /** The mascot says what a click does and which version is on screen. */
  register(handlers: { activate(): void; shown(): MascotVersion }): () => void;
}

export function createAssistantController(prefs: MascotPrefsStore = createMascotPrefsStore()): AssistantController {
  let view: AssistantView = { bubble: false, focusNonce: 0 };
  let handlers: { activate(): void; shown(): MascotVersion } | null = null;
  const listeners = new Set<() => void>();
  const set = (next: AssistantView) => {
    view = next;
    for (const listener of [...listeners]) listener();
  };
  const controller: AssistantController = {
    prefs,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => view,
    openBubble() {
      // A hidden mascot shows again when asked for: the bubble is anchored to it.
      if (!prefs.get().show) prefs.update({ show: true });
      set({ bubble: true, focusNonce: view.focusNonce + 1 });
    },
    closeBubble() {
      if (view.bubble) set({ ...view, bubble: false });
    },
    ask() {
      if (!prefs.get().show) prefs.update({ show: true });
      if (handlers) handlers.activate();
      else controller.openBubble();
    },
    toggleSize() {
      const shown = handlers?.shown() ?? (prefs.get().size === "compact" ? "compact" : "full");
      prefs.update({ size: shown === "full" ? "compact" : "full" });
    },
    register(next) {
      handlers = next;
      return () => {
        if (handlers === next) handlers = null;
      };
    },
  };
  return controller;
}
