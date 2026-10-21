import { useState } from "react";
import { ConflictError } from "@thoth/local-store";
import { isReservedPath, normalizeVaultPath } from "@thoth/domain";
import { Button } from "../../ui/Button.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { useSession } from "../../app/context.ts";

/** `Notes/Ideas` or `Ideas.md` becomes a vault path ending in .md; throws on unsafe paths. */
export function pagePathFromInput(input: string): string {
  const trimmed = input.trim().replace(/^\/+/, "");
  if (trimmed === "") throw new Error("Give the page a name.");
  const withExt = /\.(md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  let path: string;
  try {
    path = normalizeVaultPath(withExt);
  } catch {
    throw new Error("That name is not a valid page path.");
  }
  if (isReservedPath(path)) throw new Error("The .thoth folder is reserved for Thoth.");
  return path;
}

export function NewPageDialog({ onClose }: { onClose(): void }) {
  const { vault, openPage, refresh } = useSession();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path = pagePathFromInput(name);
      const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
      await vault.createPage(path, `# ${title}\n`);
      await refresh();
      onClose();
      openPage(path);
    } catch (e) {
      setError(e instanceof ConflictError ? "A page with that name already exists." : e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="New page" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form">
        <label className="field">
          <span>Name (use / for a folder, for example Projects/Plan)</span>
          <input data-autofocus className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
