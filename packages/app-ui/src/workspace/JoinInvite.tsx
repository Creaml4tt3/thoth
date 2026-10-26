import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ServerInfo } from "@thoth/platform";
import { ProblemError } from "@thoth/workspace-client";
import { parseInviteUrl } from "@thoth/workspace-protocol";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import type { ServerDirectory } from "./directory.ts";

interface Props {
  directory: ServerDirectory;
  /** How the app signs in to a server (the desktop's server card). Joining continues by itself once signed in. */
  signIn(info: ServerInfo): ReactNode;
}

type Phase = { kind: "idle" } | { kind: "busy" } | { kind: "signIn"; server: string; token: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "Join with an invite link" (ADR-0024): paste `https://<server>/i/<token>`. The server is added when the app does
 * not know it yet, signed in to when needed (joining then continues by itself), and the token is accepted with the
 * user's normal sign-in. The token goes to the server once and is not kept: the field is cleared after a join.
 */
export function JoinInvite({ directory, signIn }: Props) {
  const strings = useStrings();
  const t = strings.join;
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [said, setSaid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = { title: useId() };

  const finish = async (server: string, token: string) => {
    setPhase({ kind: "busy" });
    try {
      const capabilities = await directory.capabilitiesOf(server);
      if (capabilities && !capabilities.includes("invite-links")) {
        setError(t.unsupported);
        return;
      }
      const accepted = await directory.acceptInvite(server, token);
      const role = strings.members.roles[accepted.role];
      setSaid(accepted.joined ? t.joined(accepted.name, role) : t.already(accepted.name, role));
      setText("");
    } catch (e) {
      if (e instanceof ProblemError && e.code === "not_found") setError(t.gone);
      else if (e instanceof ProblemError && e.code === "quota_exceeded") setError(t.full(e.message));
      else setError(t.failed(message(e)));
    } finally {
      setPhase((p) => (p.kind === "busy" ? { kind: "idle" } : p));
    }
  };

  const submit = async () => {
    setError(null);
    setSaid("");
    const invite = parseInviteUrl(text);
    if (!invite) {
      setError(t.notInvite);
      return;
    }
    setPhase({ kind: "busy" });
    let info: ServerInfo;
    try {
      info = directory.serverAt(invite.origin)?.info ?? (await directory.add(invite.origin));
    } catch (e) {
      setError(t.failed(message(e)));
      setPhase({ kind: "idle" });
      return;
    }
    if (info.auth === "signed-out") {
      setPhase({ kind: "signIn", server: info.id, token: invite.token });
      return;
    }
    await finish(info.id, invite.token);
  };

  // Signed in while waiting: join right away.
  const waiting = phase.kind === "signIn" ? state.servers.find((s) => s.info.id === phase.server) : undefined;
  const ready = waiting !== undefined && waiting.info.auth !== "signed-out";
  useEffect(() => {
    if (phase.kind === "signIn" && ready) void finish(phase.server, phase.token);
    // `finish` reads the latest state; the sign-in finishing is what triggers this.
  }, [ready]);

  return (
    <section className="join-invite" aria-labelledby={ids.title}>
      <h3 id={ids.title} className="share-heading">
        {t.title}
      </h3>
      <p className="muted">{t.intro}</p>
      <form
        className="server-add"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{t.label}</span>
          <input className="input" type="text" name="invite-link" inputMode="url" placeholder="https://thoth.example.com/i/…" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <Button variant="primary" small type="submit" disabled={phase.kind === "busy"}>
          {phase.kind === "busy" ? t.joining : t.join}
        </Button>
      </form>
      {phase.kind === "signIn" && waiting && (
        <div className="join-sign-in">
          <p>{t.signIn(waiting.info.label)}</p>
          {signIn(waiting.info)}
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
    </section>
  );
}
