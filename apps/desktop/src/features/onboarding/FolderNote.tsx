import { useState, type ReactNode } from "react";
import type { Platform } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { useDesktopStrings } from "../../strings/index.ts";

/**
 * The folder picker behind "Start a new Private Space" and "Open a folder you already use" (ADR-0051 rules 3 and 4).
 * Both open the folder where it is. A folder that already holds Markdown, and that Thoth has not opened before (no
 * `.thoth/`), gets a short note first, right after the pick: Open, Choose another folder, or Escape back.
 */
export function useFolderPicker(platform: Platform, onOpen: (root: string) => void, theme: "night" | "paper" = "paper") {
  const t = useDesktopStrings().onboarding.folderNote;
  const [note, setNote] = useState<{ root: string; obsidian: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setError(null);
    try {
      const root = await platform.pickVaultFolder();
      if (!root) return;
      // Only a note: if the host cannot tell what the folder holds, the folder opens as before.
      const held = await platform.inspectFolder?.(root).catch(() => null);
      if (held?.markdown && !held.thoth) setNote({ root, obsidian: held.obsidian });
      else onOpen(root);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const dialog: ReactNode = note && (
    <Modal title={t.title} theme={theme} onClose={() => setNote(null)}>
      <div className="folder-note">
        <p>{t.body}</p>
        {note.obsidian && <p>{t.obsidian}</p>}
      </div>
      <div className="modal-actions">
        <Button
          variant="quiet"
          onClick={() => {
            setNote(null);
            void pick();
          }}
        >
          {t.another}
        </Button>
        <Button
          variant="primary"
          data-autofocus
          onClick={() => {
            setNote(null);
            onOpen(note.root);
          }}
        >
          {t.open}
        </Button>
      </div>
    </Modal>
  );

  return { pick, error, dialog };
}
