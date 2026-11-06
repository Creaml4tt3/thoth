/**
 * The Plain editor (CodeMirror and its parsers) loads the first time a page is shown in Plain mode, not at startup:
 * it is about a third of the app's code, and most people write in Blocks.
 */
import type { PlainEditor as PlainEditorType } from "./PlainEditor.tsx";

let loaded: typeof PlainEditorType | undefined;
let loading: Promise<typeof PlainEditorType> | undefined;

/** The Plain editor once it has loaded; undefined before. */
export const plainEditorNow = (): typeof PlainEditorType | undefined => loaded;

export function loadPlainEditor(): Promise<typeof PlainEditorType> {
  loading ??= import("./PlainEditor.tsx").then(
    (module) => (loaded = module.PlainEditor),
    (error: unknown) => {
      // A failed load (the app was updated underneath, say) is tried again next time.
      loading = undefined;
      throw error;
    },
  );
  return loading;
}
