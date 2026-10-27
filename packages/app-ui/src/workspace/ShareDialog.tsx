import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ShareExpiry, ShareLink, ShareLinkCreated } from "@thoth/workspace-protocol";
import type { WorkspaceClient } from "@thoth/workspace-client";
import { shellRoot } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { copyText } from "../ui/clipboard.ts";
import { Modal } from "../ui/Modal.tsx";

type ShareClient = Pick<WorkspaceClient, "createShareLink" | "listShareLinks" | "revokeShareLink">;

interface Props {
  client: ShareClient;
  workspace: string;
  page: string;
  /** The page's title, for the dialog's title. */
  title: string;
  onClose(): void;
}

const CHOICES: ShareExpiry[] = [7, 30, 90, null];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "Share…" on a workspace page (ADR-0023): make a public read-only link with an expiry, copy it, see the page's
 * active links and revoke them. The address is in the create response only (the server keeps a hash), so it is shown
 * once, right after it is made; the list names links by when they were made and the moment they stop working (the
 * server stops a link at that exact time, so the time is shown, in the person's own zone).
 */
export function ShareDialog({ client, workspace, page, title, onClose }: Props) {
  const strings = useStrings();
  const t = strings.share;
  const [expiry, setExpiry] = useState<ShareExpiry>(30);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [created, setCreated] = useState<ShareLinkCreated | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const ids = { expiry: useId(), url: useId(), active: useId(), once: useId() };
  const moment = useMemo(() => new Intl.DateTimeFormat(strings.lang, { dateStyle: "medium", timeStyle: "short" }), [strings.lang]);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const reload = useCallback(async () => {
    try {
      const next = await client.listShareLinks(workspace, page);
      if (live.current) setLinks(next);
    } catch (e) {
      if (!live.current) return;
      setLinks((prev) => prev ?? []);
      setError(t.listFailed(message(e)));
    }
  }, [client, workspace, page, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A new address is selected at once, so Cmd/Ctrl+C copies it as well as the button does.
  useEffect(() => {
    if (created) field.current?.select();
  }, [created]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setSaid("");
    try {
      const link = await client.createShareLink(workspace, page, expiry);
      if (!live.current) return;
      setCreated(link);
      await reload();
    } catch (e) {
      if (live.current) setError(t.failed(message(e)));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await copyText(created.url);
      setSaid(t.copied);
    } catch {
      field.current?.select();
      setSaid(t.copyFailed);
    }
  };

  const revoke = async (link: ShareLink) => {
    setError(null);
    try {
      await client.revokeShareLink(workspace, link.id);
      if (!live.current) return;
      if (created?.id === link.id) setCreated(null);
      setSaid(t.revoked);
      await reload();
    } catch (e) {
      if (live.current) setError(t.revokeFailed(message(e)));
    }
  };

  const choiceLabel = (choice: ShareExpiry) => (choice === null ? t.never : t.days(choice));

  return createPortal(
    <Modal title={t.title(title)} onClose={onClose}>
      <p className="share-intro">{t.intro}</p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <fieldset className="share-expiry">
          <legend id={ids.expiry}>{t.expiry}</legend>
          <div className="share-choices">
            {CHOICES.map((choice) => (
              <label key={String(choice)} className="share-choice">
                <input type="radio" name="share-expiry" checked={expiry === choice} disabled={busy} onChange={() => setExpiry(choice)} {...(choice === 30 ? { "data-autofocus": "" } : {})} />
                <span>{choiceLabel(choice)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="move-actions">
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? t.creating : t.create}
          </Button>
        </div>
      </form>
      {created && (
        <div className="share-new">
          <label htmlFor={ids.url} className="share-label">
            {t.newLink}
          </label>
          <div className="share-copy">
            <input id={ids.url} ref={field} className="input mono" readOnly value={created.url} aria-describedby={ids.once} onFocus={(event) => event.currentTarget.select()} />
            <Button variant="primary" onClick={() => void copy()}>
              {t.copy}
            </Button>
          </div>
          <p id={ids.once} className="share-note">
            {t.onlyOnce}
          </p>
        </div>
      )}
      <p role="status" className="share-said">
        {said}
      </p>
      {error !== null && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <section className="share-active" aria-labelledby={ids.active}>
        <h3 id={ids.active} className="share-heading">
          {t.active}
        </h3>
        {links === null ? (
          <p className="share-note">{t.loading}</p>
        ) : links.length === 0 ? (
          <p className="share-note">{t.none}</p>
        ) : (
          <ul className="share-links" aria-labelledby={ids.active}>
            {links.map((link) => {
              const made = moment.format(new Date(link.createdAt));
              return (
                <li key={link.id} className="share-link">
                  <span>
                    {t.created(made)} · {link.expiresAt === null ? t.neverExpires : t.expires(moment.format(new Date(link.expiresAt)))}
                  </span>
                  <Button small variant="quiet" aria-label={t.revokeLabel(made)} onClick={() => void revoke(link)}>
                    {t.revoke}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {t.done}
        </Button>
      </div>
    </Modal>,
    shellRoot(),
  );
}
