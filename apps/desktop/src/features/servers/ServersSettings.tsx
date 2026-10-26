import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ServerInfo } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import type { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { describeLimits } from "@thoth/app-ui/workspace/limits.ts";
import { JoinInvite } from "@thoth/app-ui/workspace/JoinInvite.tsx";
import { STARTER_SERVER, isStarter, type StarterServer } from "@thoth/app-ui/workspace/starter.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings, type DesktopStrings } from "../../strings/index.ts";
import { tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Host errors carry a code; turn the two server ones into plain words. */
function addError(error: unknown, t: DesktopStrings["servers"]): string {
  const code = (error as { code?: unknown } | null)?.code;
  const detail = message(error);
  if (code === "SERVER_UNREACHABLE") return t.unreachable(detail);
  if (code === "BAD_ARGUMENT" || code === "NOT_ALLOWED") return t.unusable(detail);
  return detail;
}

export { describeLimits };

/** The built-in demo server is shown with its name and caution in the UI language; any other starter as given. */
function localStarter(starter: StarterServer | null, t: DesktopStrings["servers"]): StarterServer | null {
  if (!starter || starter.url !== STARTER_SERVER.url || starter.name !== STARTER_SERVER.name) return starter;
  return { url: starter.url, ...t.starter };
}

type Busy = null | { kind: "browser"; provider: string } | { kind: "token" | "signout" | "remove" };

/** One server: account, limits, sign-in (browser or token), sign out, remove. `signInOnly` hides sign out and remove (sign-in prompt over an open page). */
export function ServerCard({ info, error, directory, signInOnly = false }: { info: ServerInfo; error: string | null; directory: ServerDirectory; signInOnly?: boolean }) {
  const { options } = useSession();
  const t = useDesktopStrings().servers;
  const limitsText = useStrings().limits;
  const starter = localStarter(options.starterServer, t);
  const caution = isStarter(starter, info.url) ? starter?.caution : undefined;
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const tokenField = useRef<HTMLInputElement>(null);
  /** Set by Cancel: the host then rejects the waiting sign-in, which is not a failure to report. */
  const cancelled = useRef(false);
  const titleId = `server-${info.id}`;
  const signedIn = info.auth !== "signed-out";
  const limits = info.limits ? describeLimits(info.limits, limitsText) : [];

  const run = async (next: Exclude<Busy, null>, work: () => Promise<unknown>) => {
    setBusy(next);
    setFailure(null);
    try {
      await work();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(null);
    }
  };

  const signIn = (provider: { id: string; name: string }) =>
    run({ kind: "browser", provider: provider.name }, async () => {
      cancelled.current = false;
      try {
        await directory.signIn(info.id, provider.id);
      } catch (e) {
        if (cancelled.current) return;
        throw e;
      }
    });

  const submitToken = (event: React.FormEvent) => {
    event.preventDefault();
    const field = tokenField.current;
    if (!field) return;
    // Read once, clear at once: the token is never kept in React state or anywhere else in the webview.
    const token = field.value.trim();
    field.value = "";
    if (token === "") return;
    void run({ kind: "token" }, async () => {
      await directory.useToken(info.id, token);
      setTokenOpen(false);
    });
  };

  return (
    <article className="server-card" aria-labelledby={titleId}>
      <div className="server-head">
        <div className="server-id">
          <h3 id={titleId} className="server-name" {...tipIfClipped(info.label)}>
            {info.label}
          </h3>
          <p className="mono muted server-url" {...tipIfClipped(info.url)}>
            {info.url}
          </p>
        </div>
        <span className={`badge ${signedIn ? "badge-workspace" : "badge-muted"}`}>{signedIn ? t.signedIn : t.signedOut}</span>
      </div>

      <p className="server-account" data-testid="server-account">
        {signedIn ? t.account(info.account?.displayName ?? null, info.account?.email, info.auth === "token") : t.notSignedIn}
      </p>

      {caution && <p className="server-caution">{caution}</p>}

      {limits.length > 0 && (
        <div className="server-limits">
          <p className="muted">{t.limitsTitle}</p>
          <ul>
            {limits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {error && signedIn && (
        <p role="alert" className="alert alert-warning">
          {error}
        </p>
      )}

      {busy?.kind === "browser" ? (
        <div className="server-waiting" role="status">
          <span>{t.waiting(busy.provider)}</span>
          <Button
            variant="ghost"
            small
            onClick={() => {
              cancelled.current = true;
              void directory.cancelSignIn(info.id).catch(() => undefined);
            }}
          >
            {t.cancel}
          </Button>
        </div>
      ) : (
        <div className="set-actions">
          {!signedIn &&
            info.providers.map((provider) => (
              <Button key={provider.id} variant="primary" small disabled={busy !== null} onClick={() => void signIn(provider)}>
                {t.signInWith(provider.name)}
              </Button>
            ))}
          {!signedIn && !tokenOpen && (
            <Button variant="ghost" small disabled={busy !== null} onClick={() => setTokenOpen(true)}>
              {t.useToken}
            </Button>
          )}
          {signedIn && !signInOnly && (
            <Button variant="ghost" small disabled={busy !== null} onClick={() => void run({ kind: "signout" }, () => directory.signOut(info.id))}>
              {busy?.kind === "signout" ? t.signingOut : t.signOut}
            </Button>
          )}
          {!signInOnly && (
            <Button variant="danger" small disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
              {t.remove}
            </Button>
          )}
        </div>
      )}

      {!signedIn && tokenOpen && busy?.kind !== "browser" && (
        <form className="form server-token" onSubmit={submitToken}>
          <label className="field">
            <span>{t.tokenLabel}</span>
            <input ref={tokenField} className="input" type="password" name="token" autoComplete="off" spellCheck={false} data-autofocus />
          </label>
          <div className="set-actions">
            <Button variant="primary" small type="submit" disabled={busy !== null}>
              {busy?.kind === "token" ? t.checking : t.signInWithToken}
            </Button>
            <Button
              variant="quiet"
              small
              onClick={() => {
                if (tokenField.current) tokenField.current.value = "";
                setTokenOpen(false);
              }}
            >
              {t.cancel}
            </Button>
          </div>
        </form>
      )}

      {failure && (
        <p role="alert" className="alert alert-danger">
          {failure}
        </p>
      )}

      {confirmRemove && (
        <Modal title={t.removeTitle(info.label)} onClose={() => setConfirmRemove(false)}>
          <p>{t.removeBody}</p>
          <div className="modal-actions">
            <Button variant="quiet" onClick={() => setConfirmRemove(false)}>
              {t.keepIt}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmRemove(false);
                void run({ kind: "remove" }, () => directory.remove(info.id));
              }}
            >
              {t.removeServer}
            </Button>
          </div>
        </Modal>
      )}
    </article>
  );
}

/** Settings → Servers: add a server, sign in (browser or token), sign out, remove, and join a workspace with an invite link. */
export function ServersSettings({ focus }: { focus: boolean }) {
  const { servers, options } = useSession();
  const t = useDesktopStrings().servers;
  const state = useSyncExternalStore(servers.subscribe, servers.getState);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingStarter, setAddingStarter] = useState(false);
  const [starterError, setStarterError] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const starter = localStarter(options.starterServer, t);
  // Suggested until added. Nothing is sent to it before the user chooses Add.
  const suggestStarter = starter !== null && state.loaded && !state.servers.some((s) => isStarter(starter, s.info.url));

  const addStarter = async () => {
    if (!starter) return;
    setAddingStarter(true);
    setStarterError(null);
    try {
      await servers.add(starter.url);
    } catch (e) {
      setStarterError(addError(e, t));
    } finally {
      setAddingStarter(false);
    }
  };

  useEffect(() => {
    if (focus) section.current?.scrollIntoView({ block: "start" });
  }, [focus]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const address = url.trim();
    if (address === "") {
      setError(t.enterAddress);
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await servers.add(address);
      setUrl("");
    } catch (e) {
      setError(addError(e, t));
    } finally {
      setAdding(false);
    }
  };

  return (
    <section ref={section} aria-labelledby="set-servers" className="set-section" id="settings-servers">
      <h2 id="set-servers">{t.title}</h2>
      <p className="muted">{t.intro}</p>
      {state.error && (
        <p role="alert" className="alert alert-warning">
          {state.error}
        </p>
      )}
      {state.servers.map((entry) => (
        <ServerCard key={entry.info.id} info={entry.info} error={entry.error} directory={servers} />
      ))}
      {suggestStarter && (
        <div className="server-starter" role="group" aria-labelledby="server-starter-name">
          <div className="server-head">
            <div>
              <p id="server-starter-name" className="server-name">
                {starter.name}
              </p>
              <p className="mono muted">{starter.url}</p>
            </div>
            <span className="badge badge-muted">{t.suggested}</span>
          </div>
          <p className="server-caution">{starter.caution}</p>
          <div className="set-actions">
            <Button variant="primary" small disabled={addingStarter} onClick={() => void addStarter()}>
              {addingStarter ? t.connecting : t.addStarter(starter.name)}
            </Button>
          </div>
          {starterError && (
            <p role="alert" className="alert alert-danger">
              {starterError}
            </p>
          )}
        </div>
      )}
      <form className="server-add" onSubmit={(e) => void add(e)} aria-label={t.addServer}>
        <label className="field">
          <span>{t.address}</span>
          <input className="input" type="text" inputMode="url" placeholder="https://thoth.example.com" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="url" spellCheck={false} />
        </label>
        <Button variant="primary" small type="submit" disabled={adding}>
          {adding ? t.connecting : t.addServer}
        </Button>
      </form>
      {error && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <JoinInvite directory={servers} signIn={(info) => <ServerCard info={info} error={null} directory={servers} signInOnly />} />
    </section>
  );
}
