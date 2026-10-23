import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { docToMarkdown, markdownToDoc } from "@thoth/editor";
import type { JSONContent } from "@tiptap/core";
import { EditorState, Selection } from "@tiptap/pm/state";
import type { EditorBridge } from "./page-session.ts";
import { createEditorExtensions } from "./extensions.ts";
import type { EditorContext } from "./context.ts";

export interface PageEditorHandle extends EditorBridge {
  focus(): void;
}

interface Props {
  ctx: EditorContext;
  /** Fired for every user edit (not for programmatic loads). */
  onEdit(): void;
  onSaveShortcut(): void;
  handleRef: Ref<PageEditorHandle>;
}

/** Tiptap editor over the Thoth schema. It holds the document; `PageSession` decides when it is saved. */
export function PageEditor({ ctx, onEdit, onSaveShortcut, handleRef }: Props) {
  const frontmatter = useRef("");
  const loading = useRef(false);
  const edit = useRef(onEdit);
  const save = useRef(onSaveShortcut);
  edit.current = onEdit;
  save.current = onSaveShortcut;
  const extensions = useMemo(() => createEditorExtensions(ctx), [ctx]);

  const editor = useEditor({
    extensions,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "prose", role: "textbox", "aria-multiline": "true", "aria-label": "Page content", spellcheck: "true" },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          save.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ transaction }) => {
      if (loading.current || !transaction.docChanged) return;
      edit.current();
    },
  });

  useImperativeHandle(
    handleRef,
    (): PageEditorHandle => ({
      markdown() {
        if (!editor) return "";
        return docToMarkdown(editor.getJSON() as JSONContent, { frontmatter: frontmatter.current });
      },
      load(source) {
        if (!editor) return;
        const { doc: json, frontmatter: fm } = markdownToDoc(source);
        frontmatter.current = fm;
        const old = editor.state;
        const hadFocus = editor.isFocused;
        const doc = editor.schema.nodeFromJSON(json);
        // A fresh state (not a transaction) so undo history starts clean: Undo must never resurrect replaced text.
        const next = EditorState.create({ schema: editor.schema, doc, plugins: old.plugins });
        const at = (pos: number): number => Math.max(0, Math.min(pos, doc.content.size));
        const selection = Selection.near(doc.resolve(at(old.selection.from)));
        loading.current = true;
        try {
          editor.view.updateState(next.apply(next.tr.setSelection(selection).setMeta("addToHistory", false)));
        } finally {
          loading.current = false;
        }
        if (hadFocus) editor.commands.focus(undefined, { scrollIntoView: false });
      },
      setEditable(editable) {
        editor?.setEditable(editable, false);
      },
      focus() {
        editor?.commands.focus();
      },
    }),
    [editor],
  );

  useEffect(() => () => editor?.destroy(), [editor]);

  return <EditorContent editor={editor} className="editor-surface" />;
}
