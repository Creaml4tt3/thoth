/**
 * Adding images to a page (ADR-0028), Blocks mode: `/` Image (the picker), and image files pasted or dropped on the
 * page. Each file is kept by the page's space (copied next to the page, or uploaded as a workspace attachment) and an
 * image block with a relative `src` and an alt text from the file name goes in at the cursor or where it was dropped:
 * an empty paragraph there becomes the image, otherwise it goes after the block. Each image is one undo step; undo
 * takes it out of the page and leaves the kept file where it is.
 *
 * Also: Enter on a selected image opens its alt text field. Progress and errors are said in a live region.
 */
import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { NodeType } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { EditorContext } from "./context.ts";
import { editImageAlt } from "./image-views.ts";
import { ImageRejectedError, MAX_IMAGE_BYTES, imageMimeType, isImageMimeType, type ImageFile } from "./media.ts";

interface Pending {
  /** Insertion points waiting for a file (a picker open, an upload running), mapped through every change. */
  at: Map<number, number>;
}

const key = new PluginKey<Pending>("thothImageInsert");
let nextId = 0;

type Meta = { add: [number, number] } | { remove: number };

/** Puts an image block at `pos`: an empty paragraph there becomes the image, otherwise it goes after that block. Returns where it went. */
export function placeImage(tr: Transaction, pos: number, attrs: { src: string; alt: string }): number | null {
  const type: NodeType | undefined = tr.doc.type.schema.nodes["image"];
  if (!type) return null;
  const node = type.create({ src: attrs.src, alt: attrs.alt, title: null });
  let $p = tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size)));
  if ($p.parent.isTextblock && $p.depth > 0) {
    const d = $p.depth;
    const container = $p.node(d - 1);
    const index = $p.index(d - 1);
    if ($p.parent.type.name === "paragraph" && $p.parent.content.size === 0 && container.canReplaceWith(index, index + 1, type)) {
      const start = $p.before(d);
      tr.replaceWith(start, $p.after(d), node);
      return start;
    }
    $p = tr.doc.resolve($p.after(d));
  }
  while ($p.depth > 0 && !$p.parent.canReplaceWith($p.index(), $p.index(), type)) $p = tr.doc.resolve($p.after());
  if (!$p.parent.canReplaceWith($p.index(), $p.index(), type)) return null;
  tr.insert($p.pos, node);
  return $p.pos;
}

/** The files among `list` a page can show, by type or by name. */
function imageFiles(list: FileList | readonly File[] | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => isImageMimeType(f.type) || imageMimeType(f.name) !== null);
}

async function readFile(file: File): Promise<ImageFile> {
  // Refused before reading, so a huge file is never loaded into memory.
  if (file.size > MAX_IMAGE_BYTES) throw new ImageRejectedError("too-large", "The image is larger than 20 MB.");
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), type: file.type };
}

/** A small live region next to the editor: successes for screen readers, errors for everyone. */
function createStatus(view: EditorView): { say(text: string, error?: boolean): void; destroy(): void } {
  const region = document.createElement("div");
  region.className = "image-insert-status sr-only";
  // A live region without the `status` role: the page's save status is the one status there.
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  view.dom.parentElement?.append(region);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    say(text, error = false) {
      clearTimeout(timer);
      region.textContent = text;
      region.className = error ? "image-insert-status is-error" : "image-insert-status sr-only";
      timer = setTimeout(() => {
        region.textContent = "";
        region.className = "image-insert-status sr-only";
      }, error ? 10_000 : 4000);
    },
    destroy() {
      clearTimeout(timer);
      region.remove();
    },
  };
}

const statuses = new WeakMap<EditorView, ReturnType<typeof createStatus>>();

function reasonOf(ctx: EditorContext, error: unknown): string {
  const t = ctx.strings.image;
  if (error instanceof ImageRejectedError) return error.reason === "too-large" ? t.fileTooLarge : t.notAnImageFile;
  // The host's picker refuses with these codes (ADR-0028).
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "TOO_LARGE") return t.fileTooLarge;
  if (code === "NOT_AN_IMAGE") return t.notAnImageFile;
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Reserves an insertion point at `pos`; it follows every change until `release`. */
function reserve(view: EditorView, pos: number): { at(): number | undefined; move(to: number): void; release(): void } {
  const id = ++nextId;
  view.dispatch(view.state.tr.setMeta(key, { add: [id, pos] } satisfies Meta).setMeta("addToHistory", false));
  return {
    at: () => key.getState(view.state)?.at.get(id),
    move: (to) => view.dispatch(view.state.tr.setMeta(key, { add: [id, to] } satisfies Meta).setMeta("addToHistory", false)),
    release: () => {
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { remove: id } satisfies Meta).setMeta("addToHistory", false));
    },
  };
}

/** Keeps each file through the page's space and puts its image in at `pos`, in order. */
export async function insertImageFiles(view: EditorView, ctx: EditorContext, pos: number, files: readonly (File | ImageFile)[]): Promise<void> {
  const t = ctx.strings.image;
  const media = ctx.media();
  const status = statuses.get(view);
  if (!media?.add || files.length === 0) return;
  const point = reserve(view, pos);
  try {
    for (const file of files) {
      status?.say(t.adding);
      let added: { src: string; alt: string };
      try {
        const image = file instanceof File ? await readFile(file) : file;
        added = await media.add(image);
      } catch (error) {
        status?.say(t.addFailed(reasonOf(ctx, error)), true);
        continue;
      }
      const at = point.at();
      if (view.isDestroyed || at === undefined || !view.editable) return;
      const tr = closeHistory(view.state.tr);
      const placed = placeImage(tr, at, added);
      if (placed === null) continue;
      tr.setSelection(NodeSelection.create(tr.doc, placed));
      view.dispatch(tr.scrollIntoView());
      view.dispatch(closeHistory(view.state.tr));
      // The next one goes after this one.
      point.move(placed + (view.state.doc.nodeAt(placed)?.nodeSize ?? 0));
      status?.say(t.added(decodeName(added.src)));
    }
  } finally {
    point.release();
  }
}

const decodeName = (src: string): string => {
  const last = src.slice(src.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** `/` Image: asks for a file (the picker) and puts it in at `pos`. */
export async function pickAndInsertImage(view: EditorView, ctx: EditorContext, pos: number): Promise<void> {
  if (!ctx.pickImage) return;
  const point = reserve(view, pos);
  let file: ImageFile | null;
  try {
    file = await ctx.pickImage();
  } catch (error) {
    point.release();
    statuses.get(view)?.say(ctx.strings.image.addFailed(reasonOf(ctx, error)), true);
    return;
  }
  const at = point.at();
  point.release();
  if (!file || at === undefined || view.isDestroyed) return;
  await insertImageFiles(view, ctx, at, [file]);
}

/** True when this page can take images (the space keeps files, and the editor is editable). */
export const canAddImages = (view: EditorView, ctx: EditorContext): boolean => view.editable && !!ctx.media()?.add;

export function imageInsertExtension(ctx: EditorContext) {
  return Extension.create({
    name: "thothImageInsert",
    addProseMirrorPlugins() {
      return [
        new Plugin<Pending>({
          key,
          state: {
            init: () => ({ at: new Map() }),
            apply(tr, value) {
              const meta = tr.getMeta(key) as Meta | undefined;
              if (!tr.docChanged && !meta) return value;
              const at = new Map<number, number>();
              for (const [id, pos] of value.at) at.set(id, tr.docChanged ? tr.mapping.map(pos) : pos);
              if (meta && "add" in meta) at.set(meta.add[0], meta.add[1]);
              if (meta && "remove" in meta) at.delete(meta.remove);
              return { at };
            },
          },
          view(view) {
            statuses.set(view, createStatus(view));
            return {
              destroy: () => {
                statuses.get(view)?.destroy();
                statuses.delete(view);
              },
            };
          },
          props: {
            handleKeyDown(view, event) {
              const { selection } = view.state;
              if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || !view.editable) return false;
              if (!(selection instanceof NodeSelection)) return false;
              if (selection.node.type.name !== "image" && selection.node.type.name !== "inlineImage") return false;
              event.preventDefault();
              return editImageAlt(view, selection.from);
            },
            handleDOMEvents: {
              paste(view, event) {
                const list = imageFiles(event.clipboardData?.files);
                if (list.length === 0 || !canAddImages(view, ctx)) return false;
                event.preventDefault();
                void insertImageFiles(view, ctx, view.state.selection.to, list);
                return true;
              },
              drop(view, event) {
                const dropped = event.dataTransfer?.files;
                if (!dropped || dropped.length === 0 || view.dragging) return false;
                if (!canAddImages(view, ctx)) return false;
                // Files the page cannot show are refused here, so the window never opens them in place of the app.
                event.preventDefault();
                const list = imageFiles(dropped);
                if (list.length === 0) {
                  statuses.get(view)?.say(ctx.strings.image.addFailed(ctx.strings.image.notAnImageFile), true);
                  return true;
                }
                let pos = view.state.selection.to;
                try {
                  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
                  if (hit) pos = hit.pos;
                } catch {
                  // no layout (tests): the cursor
                }
                void insertImageFiles(view, ctx, pos, list);
                return true;
              },
            },
          },
        }),
      ];
    },
  });
}
