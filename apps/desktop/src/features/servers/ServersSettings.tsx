import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ServerInfo } from "@thoth/platform";
import { useSession } from "../../app/context.ts";
import { Button } from "../../ui/Button.tsx";
import { Modal } from "../../ui/Modal.tsx";
import type { ServerDirectory } from "./directory.ts";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Host errors carry a code; turn the two server ones into plain words. */
function addError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const detail = message(error);
  if (code === "SERVER_UNREACHABLE") return `Could not reach a Thoth server at that address. ${detail}`;
  if (code === "BAD_ARGUMENT" || code === "NOT_ALLOWED") return `That address cannot be used. ${detail}`;
  return detail;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function bytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? plural(n, "byte") : `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Advertised limits in plain words. Unknown limits are listed by name so nothing is hidden. */
export function describeLimits(limits: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [name, n] of Object.entries(limits)) {
    switch (name) {
      case "maxPagesPerWorkspace":
        out.push(`${plural(n, "page")} per workspace`);
        break;
      case "maxMembersPerWorkspace":
        out.push(`${plural(n, "member")} per workspace`);
        break;
      case "maxWorkspacesPerAccount":
        out.push(`${plural(n, "workspace")} per account`);
        break;
      case "maxWorkspaceAttachmentBytes":
        out.push(`${bytes(n)} of attachments per workspace`);
        break;
      case "maxAttachmentBytes":
        out.push(`${bytes(n)} per attachment`);
        break;
      case "maxMarkdownBytes":
        out.push(`${bytes(n)} per page`);
        break;
      case "revisionRetentionDays":
        out.push(`Old versions of a page are kept for ${plural(n, "day")}`);
        break;
      case "maxPageSize":
      case "idempotencyWindowSeconds":
        break; // protocol tuning, not something a person plans around
      default:
        out.push(`${name}: ${n.toLocaleString()}`);
    }
  }
  return out;
}

type Busy = null | { kind: "browser"; provider: string } | { kind: "token" | "signout" | "remove" };

/** One server: account, limits, sign-in (browser or token), sign out, remove. `signInOnly` hides sign out and remove (sign-in prompt over an open page). */
export function ServerCard({ info, error, directory, signInOnly = false }: { info: ServerInfo; error: string | null; directory: ServerDirectory; signInOnly?: boolean }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const tokenField = useRef<HTMLInputElement>(null);
  /** Set by Cancel: the host then rejects the waiting sign-in, which is not a failure to report. */
  const cancelled = useRef(false);
  const titleId = `server-${info.id}`;
  const signedIn = info.auth !== "signed-out";
  const limits = info.limits ? describeLimits(info.limits) : [];

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
        <div>
          <h3 id={titleId} className="server-name">
            {info.label}
          </h3>
          <p className="mono muted">{info.url}</p>
        </div>
        <span className={`badge ${signedIn ? "badge-workspace" : "badge-muted"}`}>{signedIn ? "Signed in" : "Signed out"}</span>
      </div>

      <p className="server-account" data-testid="server-account">
        {signedIn
          ? info.account
            ? `Signed in as ${info.account.displayName}${info.account.email ? ` (${info.account.email})` : ""}${info.auth === "token" ? " with a personal access token" : ""}.`
            : `Signed in${info.auth === "token" ? " with a personal access token" : ""}.`
          : "Not signed in."}
      </p>

      {limits.length > 0 && (
        <div className="server-limits">
          <p className="muted">This server has limits:</p>
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
          <span>Finish signing in with {busy.provider} in your browser. Thoth is waiting for it to come back.</span>
          <Button
            variant="ghost"
            small
            onClick={() => {
              cancelled.current = true;
              void directory.cancelSignIn(info.id).catch(() => undefined);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="set-actions">
          {!signedIn &&
            info.providers.map((provider) => (
              <Button key={provider.id} variant="primary" small disabled={busy !== null} onClick={() => void signIn(provider)}>
                Sign in with {provider.name}
              </Button>
            ))}
          {!signedIn && !tokenOpen && (
            <Button variant="ghost" small disabled={busy !== null} onClick={() => setTokenOpen(true)}>
              Use a personal access token
            </Button>
          )}
          {signedIn && !signInOnly && (
            <Button variant="ghost" small disabled={busy !== null} onClick={() => void run({ kind: "signout" }, () => directory.signOut(info.id))}>
              {busy?.kind === "signout" ? "Signing out…" : "Sign out"}
            </Button>
          )}
          {!signInOnly && (
            <Button variant="danger" small disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      )}

      {!signedIn && tokenOpen && busy?.kind !== "browser" && (
        <form className="form server-token" onSubmit={submitToken}>
          <label className="field">
            <span>Personal access token (sent once to the app's host and stored in your system keychain; it is never shown again)</span>
            <input ref={tokenField} className="input" type="password" name="token" autoComplete="off" spellCheck={false} data-autofocus />
          </label>
          <div className="set-actions">
            <Button variant="primary" small type="submit" disabled={busy !== null}>
              {busy?.kind === "token" ? "Checking…" : "Sign in with token"}
            </Button>
            <Button
              variant="quiet"
              small
              onClick={() => {
                if (tokenField.current) tokenField.current.value = "";
                setTokenOpen(false);
              }}
            >
              Cancel
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
        <Modal title={`Remove ${info.label}?`} onClose={() => setConfirmRemove(false)}>
          <p>Thoth signs you out of this server and forgets it. Pages on the server are not changed, and nothing in your Private Space is touched.</p>
          <div className="modal-actions">
            <Button variant="quiet" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmRemove(false);
                void run({ kind: "remove" }, () => directory.remove(info.id));
              }}
            >
              Remove server
            </Button>
          </div>
        </Modal>
      )}
    </article>
  );
}

/** Settings → Servers: add a server, sign in (browser or token), sign out, remove. */
export function ServersSettings({ focus }: { focus: boolean }) {
  const { servers } = useSession();
  const state = useSyncExternalStore(servers.subscribe, servers.getState);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focus) section.current?.scrollIntoView({ block: "start" });
  }, [focus]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const address = url.trim();
    if (address === "") {
      setError("Enter the server's address, for example https://thoth.example.com.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await servers.add(address);
      setUrl("");
    } catch (e) {
      setError(addError(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <section ref={section} aria-labelledby="set-servers" className="set-section" id="settings-servers">
      <h2 id="set-servers">Servers</h2>
      <p className="muted">Connect to a Thoth server to work in shared workspaces. Thoth keeps your sign-in in the system keychain; this window never sees it.</p>
      {state.error && (
        <p role="alert" className="alert alert-warning">
          {state.error}
        </p>
      )}
      {state.servers.map((entry) => (
        <ServerCard key={entry.info.id} info={entry.info} error={entry.error} directory={servers} />
      ))}
      <form className="server-add" onSubmit={(e) => void add(e)} aria-label="Add server">
        <label className="field">
          <span>Server address</span>
          <input className="input" type="text" inputMode="url" placeholder="https://thoth.example.com" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="url" spellCheck={false} />
        </label>
        <Button variant="primary" small type="submit" disabled={adding}>
          {adding ? "Connecting…" : "Add server"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
    </section>
  );
}
