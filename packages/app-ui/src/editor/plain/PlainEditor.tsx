import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import type { EditorContext } from "../context.ts";
import type { PageEditorHandle } from "../PageEditor.tsx";
import { livePreview, refreshLinks } from "./live-preview.ts";
import { plainLinkSuggest } from "./link-suggest-plain.ts";
import { markdownHighlighting, markdownSupport } from "./syntax.ts";
import { normalizeLineBreaks, toEditorText } from "./text.ts";

interface Props {
  ctx: EditorContext;
  /** Fired for every user edit (not for programmatic loads). */
  onEdit(): void;
  onSaveShortcut(): void;
  handleRef: Ref<PageEditorHandle>;
}

/**
 * Plain mode: the page's Markdown as text, in CodeMirror 6, with live preview
 * (ADR-0012). What is on screen is what is written: there is no model and no
 * serializer, so `markdown()` is the loaded source with the user's keystrokes
 * applied and nothing else. `PageSession` decides when it is saved, exactly as
 * for the block editor.
 */
export function PlainEditor({ ctx, onEdit, onSaveShortcut, handleRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const bom = useRef("");
  const editable = useRef(true);
  const loading = useRef(false);
  const edit = useRef(onEdit);
  const save = useRef(onSaveShortcut);
  edit.current = onEdit;
  save.current = onSaveShortcut;
  const access = useRef(new Compartment());

  const accessExtensions = (on: boolean): Extension => [EditorState.readOnly.of(!on), EditorView.editable.of(on)];

  const createState = (source: string, cursor = 0): EditorState => {
    const { text, bom: mark, lineBreak } = toEditorText(source);
    bom.current = mark;
    return EditorState.create({
      doc: text,
      selection: EditorSelection.cursor(Math.min(cursor, text.length)),
      extensions: [
        EditorState.lineSeparator.of(lineBreak),
        access.current.of(accessExtensions(editable.current)),
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdownSupport(),
        markdownHighlighting,
        livePreview(ctx),
        plainLinkSuggest(ctx),
        EditorView.clipboardInputFilter.of(normalizeLineBreaks),
        EditorView.domEventHandlers({
          // Cmd+S and Ctrl+S on every platform, as in the block editor.
          keydown(event) {
            if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "s") return false;
            event.preventDefault();
            save.current();
            return true;
          },
        }),
        keymap.of([
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({ "aria-label": "Page content", spellcheck: "true", class: "plain-content" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !loading.current) edit.current();
        }),
      ],
    });
  };

  useLayoutEffect(() => {
    const created = new EditorView({ state: createState(""), parent: host.current! });
    view.current = created;
    const handle = { refresh: () => created.dispatch({ effects: refreshLinks.of(null) }) };
    ctx.views.add(handle);
    return () => {
      ctx.views.delete(handle);
      created.destroy();
      view.current = null;
    };
    // The view is created once per mount; `ctx` is stable for a page.
  }, [ctx]);

  useImperativeHandle(
    handleRef,
    (): PageEditorHandle => ({
      markdown() {
        const current = view.current;
        return current ? bom.current + current.state.sliceDoc() : "";
      },
      load(source) {
        const current = view.current;
        if (!current) return;
        const hadFocus = current.hasFocus;
        loading.current = true;
        try {
          // A fresh state (not a transaction) so undo history starts clean: Undo must never resurrect replaced text.
          current.setState(createState(source, current.state.selection.main.head));
        } finally {
          loading.current = false;
        }
        if (hadFocus) current.focus();
      },
      setEditable(on) {
        editable.current = on;
        view.current?.dispatch({ effects: access.current.reconfigure(accessExtensions(on)) });
      },
      focus() {
        view.current?.focus();
      },
    }),
    [],
  );

  return <div ref={host} className="editor-surface plain-editor" />;
}
