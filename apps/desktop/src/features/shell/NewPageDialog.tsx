import { useState } from "react";
import { ConflictError } from "@thoth/local-store";
import { isReservedPath, normalizeVaultPath } from "@thoth/domain";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { useSession } from "../../app/context.ts";
import { en, useDesktopStrings } from "../../strings/index.ts";

type PathProblem = keyof typeof en.newPage.errors;

/** Why a typed name is not a page path; the dialog shows the reason in the UI language. */
export class PagePathError extends Error {
  readonly problem: PathProblem;

  constructor(problem: PathProblem) {
    super(en.newPage.errors[problem]);
    this.name = "PagePathError";
    this.problem = problem;
  }
}

/** `Notes/Ideas` or `Ideas.md` becomes a vault path ending in .md; throws `PagePathError` on unsafe paths. */
export function pagePathFromInput(input: string): string {
  const trimmed = input.trim().replace(/^\/+/, "");
  if (trimmed === "") throw new PagePathError("empty");
  const withExt = /\.(md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  let path: string;
  try {
    path = normalizeVaultPath(withExt);
  } catch {
    throw new PagePathError("invalid");
  }
  if (isReservedPath(path)) throw new PagePathError("reserved");
  return path;
}

export function NewPageDialog({ onClose }: { onClose(): void }) {
  const { vault, openPage, refresh } = useSession();
  const t = useDesktopStrings().newPage;
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
      setError(e instanceof PagePathError ? t.errors[e.problem] : e instanceof ConflictError ? t.exists : e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={t.title} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form">
        <label className="field">
          <span>{t.name}</span>
          <input data-autofocus className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {t.create}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
