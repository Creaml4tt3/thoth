import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProblemError } from "@thoth/workspace-client";
import { FEEDBACK_KINDS, FEEDBACK_MESSAGE_MAX, FeedbackRequestSchema, type FeedbackContext, type FeedbackKind, type FeedbackRequest } from "@thoth/workspace-protocol";
import { shellRoot } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import { copyText } from "../ui/clipboard.ts";
import type { ServerEntry } from "../workspace/directory.ts";

/** The fallback on every form (ADR-0033): mail always works, even with no server at all. */
export const FEEDBACK_EMAIL = "support@thothnotes.com";
const MAILTO = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent("Thoth feedback")}`;

/** Where the dialog sends: a server's name and its `sendFeedback`. */
export interface FeedbackTarget {
  label: string;
  send(input: FeedbackRequest): Promise<void>;
}

/**
 * Which server takes the feedback (ADR-0033): the demo server once the person has added it (feedback needs no
 * sign-in), else the first signed-in server that lists `feedback`. A server that has not been added is never
 * contacted, so with none of these the dialog offers the email link only.
 */
export async function pickFeedbackServer(servers: readonly ServerEntry[], capabilitiesOf: (server: string) => Promise<string[] | null>, starterUrl: string | null): Promise<ServerEntry | null> {
  const takes = async (s: ServerEntry) => (await capabilitiesOf(s.info.id).catch(() => null))?.includes("feedback") ?? false;
  const starter = starterUrl === null ? undefined : servers.find((s) => s.info.url === originOf(starterUrl));
  if (starter && (await takes(starter))) return starter;
  for (const s of servers) if (s !== starter && s.info.auth !== "signed-out" && (await takes(s))) return s;
  return null;
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

interface Props {
  /** Finds the server to send to; `null` when none can take it. Called once, when the dialog opens. */
  target(): Promise<FeedbackTarget | null>;
  /** What "Include the app version and system" adds, shown exactly as it is sent. */
  context: FeedbackContext;
  /** The email fallback: a `mailto:` link (the web), or the address with a Copy button where links to mail cannot open (the desktop webview, ADR-0020). */
  mail?: "link" | "copy";
  /** The newest lines of the app's redacted local log (ADR-0040), read only once "Include recent app log" is ticked. Absent (the web): no such box. */
  diagnostics?: () => Promise<string[]>;
  onClose(): void;
}

type Field = "message" | "email";
type Log = { state: "idle" } | { state: "loading" } | { state: "failed" } | { state: "loaded"; lines: string[] };
type Phase = { state: "looking" } | { state: "none" } | { state: "ready"; target: FeedbackTarget } | { state: "sent" };

/**
 * "Send feedback" (ADR-0033): the kind, the message, an optional email, and "Include the app version and system" (on
 * by default; what it adds is on screen). Errors sit under their fields and the first one takes the focus; the result
 * is announced. The email link is always there.
 */
export function FeedbackDialog({ target, context, mail: mailKind = "link", diagnostics, onClose }: Props) {
  const t = useStrings().feedback;
  const [phase, setPhase] = useState<Phase>({ state: "looking" });
  const [kind, setKind] = useState<FeedbackKind>("problem");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [include, setInclude] = useState(true);
  // Off on every open (ADR-0040): the log is read only when ticked, then kept for the life of the dialog.
  const [withLog, setWithLog] = useState(false);
  const [log, setLog] = useState<Log>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const id = { message: useId(), email: useId(), messageHint: useId(), emailHint: useId(), messageError: useId(), emailError: useId(), details: useId(), logHint: useId() };
  const refs = { message: useRef<HTMLTextAreaElement>(null), email: useRef<HTMLInputElement>(null) };
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    target()
      .then((found) => live.current && setPhase(found ? { state: "ready", target: found } : { state: "none" }))
      .catch(() => live.current && setPhase({ state: "none" }));
    return () => {
      live.current = false;
    };
    // `target` is read once, when the dialog opens.
  }, []);
  // The form, or the result, arrives after the dialog opened: it takes the focus then.
  const form = useRef<HTMLFormElement>(null);
  const closeAfter = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase.state === "ready") form.current?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
    if (phase.state === "sent") closeAfter.current?.focus();
  }, [phase.state]);

  const tickLog = (on: boolean) => {
    setWithLog(on);
    // Unticking after a failed read lets the next tick try again.
    if (!on && log.state === "failed") setLog({ state: "idle" });
    if (!on || !diagnostics || (log.state !== "idle" && log.state !== "failed")) return;
    setLog({ state: "loading" });
    diagnostics().then(
      (lines) => live.current && setLog({ state: "loaded", lines }),
      () => live.current && setLog({ state: "failed" }),
    );
  };
  // The schema needs at least one line: an empty or unread log is simply not sent.
  const sentLog = withLog && log.state === "loaded" && log.lines.length > 0 ? log.lines : null;

  const submit = async (to: FeedbackTarget) => {
    const input: FeedbackRequest = { kind, message, ...(email.trim() === "" ? {} : { email: email.trim() }), ...(include ? { context } : {}), ...(sentLog ? { diagnostics: { log: sentLog } } : {}) };
    const next: Partial<Record<Field, string>> = {};
    if (message.trim() === "") next.message = t.errors.message;
    else if (message.length > FEEDBACK_MESSAGE_MAX) next.message = t.errors.messageLong(FEEDBACK_MESSAGE_MAX);
    const parsed = FeedbackRequestSchema.safeParse(input);
    if (!parsed.success && parsed.error.issues.some((i) => i.path[0] === "email")) next.email = t.errors.email;
    setErrors(next);
    setFailure(null);
    const first = (["message", "email"] as const).find((f) => next[f]);
    if (first) return refs[first].current?.focus();
    if (!parsed.success) return setFailure(t.failed(parsed.error.issues[0]?.message ?? ""));
    setBusy(true);
    try {
      await to.send(parsed.data);
      if (live.current) setPhase({ state: "sent" });
    } catch (e) {
      if (!live.current) return;
      // An older server's strict schema refuses `diagnostics` with a 400; say what to do rather than retry without it.
      setFailure(e instanceof ProblemError && e.code === "rate_limited" ? t.busy : e instanceof ProblemError && e.status === 400 && input.diagnostics ? t.logRefused : t.failed(e instanceof Error ? e.message : String(e)));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const mail =
    mailKind === "link" ? (
      <p className="share-note">
        <a className="sec-link" href={MAILTO} target="_blank" rel="noopener noreferrer">
          {t.orEmail}
        </a>{" "}
        <span className="mono">{FEEDBACK_EMAIL}</span>
      </p>
    ) : (
      <div className="share-note feedback-mail">
        <span>
          {t.orEmail}: <span className="mono">{FEEDBACK_EMAIL}</span>
        </span>
        <Button variant="ghost" small onClick={() => void copyText(FEEDBACK_EMAIL).then(() => live.current && setCopied(true), () => undefined)}>
          {t.copyEmail}
        </Button>
        <span role="status">{copied ? t.copied : ""}</span>
      </div>
    );
  const describe = (...ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined;

  return createPortal(
    <Modal title={t.title} onClose={onClose}>
      {phase.state === "looking" && <p className="share-intro">{t.looking}</p>}
      {phase.state === "none" && (
        <>
          <p className="share-intro">{t.noServer}</p>
          {mail}
          <div className="move-actions">
            <Button variant="quiet" onClick={onClose}>
              {t.close}
            </Button>
          </div>
        </>
      )}
      {phase.state === "sent" && (
        <>
          <p role="status" className="alert">
            {t.sent}
          </p>
          <div className="move-actions">
            <Button ref={closeAfter} variant="primary" onClick={onClose}>
              {t.close}
            </Button>
          </div>
        </>
      )}
      {phase.state === "ready" && (
        <form
          ref={form}
          className="form feedback-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit(phase.target);
          }}
        >
          <p className="share-intro">{t.intro}</p>
          <fieldset className="share-expiry">
            <legend>{t.kind}</legend>
            <div className="share-choices">
              {FEEDBACK_KINDS.map((k) => (
                <label key={k} className="share-choice">
                  <input type="radio" name="feedback-kind" value={k} checked={kind === k} disabled={busy} onChange={() => setKind(k)} />
                  {t.kinds[k]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor={id.message}>
              <span>{t.message}</span>
            </label>
            <textarea
              ref={refs.message}
              id={id.message}
              name="message"
              className="input feedback-message"
              rows={6}
              value={message}
              disabled={busy}
              aria-invalid={errors.message ? true : undefined}
              aria-describedby={describe(errors.message !== undefined && id.messageError, id.messageHint)}
              onChange={(e) => setMessage(e.target.value)}
            />
            {errors.message && (
              <p id={id.messageError} className="field-error">
                {errors.message}
              </p>
            )}
            <p id={id.messageHint} className="share-note">
              {t.messageHint(FEEDBACK_MESSAGE_MAX)}
            </p>
          </div>
          <div className="field">
            <label htmlFor={id.email}>
              <span>{t.email}</span>
            </label>
            <input
              ref={refs.email}
              id={id.email}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              className="input"
              value={email}
              disabled={busy}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={describe(errors.email !== undefined && id.emailError, id.emailHint)}
              onChange={(e) => setEmail(e.target.value)}
            />
            {errors.email && (
              <p id={id.emailError} className="field-error">
                {errors.email}
              </p>
            )}
            <p id={id.emailHint} className="share-note">
              {t.emailHint}
            </p>
          </div>
          <label className="ws-check">
            <input type="checkbox" name="include-context" checked={include} disabled={busy} aria-describedby={include ? id.details : undefined} onChange={(e) => setInclude(e.target.checked)} />
            <span>{t.include}</span>
          </label>
          {include && (
            <div id={id.details} className="ws-check-hint feedback-details">
              <p className="share-note">{t.includeHint}</p>
              <ul className="mono">
                {Object.entries(context).map(([k, v]) => (
                  <li key={k}>{`${k}: ${v}`}</li>
                ))}
              </ul>
            </div>
          )}
          {diagnostics && (
            <>
              <label className="ws-check">
                <input type="checkbox" name="include-log" checked={withLog} disabled={busy} onChange={(e) => tickLog(e.target.checked)} />
                <span>{t.includeLog}</span>
              </label>
              {withLog && (
                <div className="ws-check-hint feedback-details">
                  {/* Announced while the box is ticked; the preview stays outside, so its lines are never read out. */}
                  <p role="status" className="share-note">
                    {log.state === "loading" ? t.logLoading : log.state === "failed" ? t.logFailed : log.state === "loaded" && log.lines.length === 0 ? t.noLog : ""}
                  </p>
                  {sentLog && (
                    <>
                      <p id={id.logHint} className="share-note">
                        {t.logHint}
                      </p>
                      <pre tabIndex={0} className="mono feedback-log" aria-describedby={id.logHint}>
                        {sentLog.join("\n")}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          <p className="share-note">{diagnostics ? t.privacyLog : t.privacy}</p>
          <p className="share-note">{t.sendingTo(phase.target.label)}</p>
          {failure !== null && (
            <div role="alert" className="alert alert-danger">
              <p>{failure}</p>
            </div>
          )}
          {mail}
          <div className="move-actions">
            <Button variant="quiet" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button variant="primary" type="submit" disabled={busy || (withLog && log.state === "loading")}>
              {busy ? t.sending : t.send}
            </Button>
          </div>
        </form>
      )}
    </Modal>,
    shellRoot(),
  );
}
