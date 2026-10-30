import { useEffect, useState, type ReactNode } from "react";
import type { DiagnosticsBundle } from "@thoth/platform";
import type { FeedbackContext } from "@thoth/workspace-protocol";
import { FEEDBACK_EMAIL, FeedbackDialog, pickFeedbackServer, type FeedbackTarget } from "@thoth/app-ui/feedback/FeedbackDialog.tsx";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { currentOs } from "../settings/path.ts";

const OS_NAMES = { mac: "macOS", windows: "Windows", linux: "Linux" } as const;

/**
 * Send feedback from the desktop app (ADR-0033). It goes through the host (`api.call`) to the demo server once the
 * person has added it, else to the first signed-in server that lists `feedback`; a server that was never added is
 * never contacted. The details it may add: the client, the running version, the system and the interface language.
 */
export function DesktopFeedbackDialog({ onClose }: { onClose(): void }) {
  const { servers, options, platform } = useSession();
  const lang = useStrings().lang;
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [arch, setArch] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    platform.updates
      ?.settings()
      .then((s) => live && setVersion(s.current))
      .catch(() => undefined);
    // Only the arch is used here; the log lines are read again, and shown, once the person ticks the box.
    platform.diagnostics
      ?.collect()
      .then((b) => live && typeof b.arch === "string" && b.arch !== "" && b.arch.length <= 20 && setArch(b.arch))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [platform]);

  // The arch rides in `os` (ADR-0040): a feedback server older than 0.3.0 has a strict context and refuses new keys.
  const context: FeedbackContext = { client: "desktop", ...(version ? { version } : {}), os: arch ? `${OS_NAMES[currentOs()]} (${arch})` : OS_NAMES[currentOs()], language: lang };
  const target = async (): Promise<FeedbackTarget | null> => {
    const entry = await pickFeedbackServer(servers.getState().servers, (id) => servers.capabilitiesOf(id), options.starterServer?.url ?? null);
    return entry ? { label: entry.info.label, send: (input) => servers.client(entry.info.id).sendFeedback(input) } : null;
  };
  // The webview cannot open mailto: links (the host's link.open takes web links only, ADR-0020): copy the address.
  const diagnostics = platform.diagnostics;
  return <FeedbackDialog target={target} context={context} mail="copy" {...(diagnostics ? { diagnostics: () => diagnostics.collect().then((b) => b.log) } : {})} onClose={onClose} />;
}

/** `thoth-diagnostics.md`: the header, then the log in a fence longer than any backtick run in it, so no line can close it. */
export function diagnosticsMarkdown(b: DiagnosticsBundle, now: Date): string {
  const head = `# Thoth diagnostics\n\n- Version: ${b.version}\n- OS: ${b.os}\n- Arch: ${b.arch}\n- Date: ${now.toISOString()}\n\n`;
  if (b.log.length === 0) return `${head}No log yet.\n`;
  const fence = "`".repeat(Math.max(3, ...b.log.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length)))) + 1);
  return `${head}${fence}\n${b.log.join("\n")}\n${fence}\n`;
}

/** Settings → Help and feedback; `children`: the desktop's other help (the tour), after sending feedback. */
export function FeedbackSettings({ children }: { children?: ReactNode }) {
  const t = useDesktopStrings().helpFeedback;
  const { platform } = useSession();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<"busy" | "saved" | "cancelled" | "failed" | null>(null);
  const { diagnostics, saveFile } = platform;
  const [logOn, setLogOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    diagnostics
      ?.enabled()
      .then((on) => live && setLogOn(on))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [diagnostics]);
  const save = async () => {
    if (!diagnostics || !saveFile) return;
    setSaved("busy");
    try {
      const ok = await saveFile("thoth-diagnostics.md", new TextEncoder().encode(diagnosticsMarkdown(await diagnostics.collect(), new Date())));
      setSaved(ok ? "saved" : "cancelled");
    } catch {
      setSaved("failed");
    }
  };
  return (
    <section aria-labelledby="set-feedback" className="set-section">
      <h2 id="set-feedback">{t.title}</h2>
      <p className="muted">{t.intro}</p>
      <div className="set-actions">
        <Button variant="primary" small onClick={() => setOpen(true)}>
          {t.send}
        </Button>
        <span className="muted">{t.email(FEEDBACK_EMAIL)}</span>
      </div>
      {diagnostics && logOn !== null && (
        <div className="set-toggle">
          <input
            id="diag-log"
            type="checkbox"
            role="switch"
            checked={logOn}
            aria-describedby="diag-log-hint"
            onChange={(e) => void diagnostics.setEnabled(e.target.checked).then(setLogOn, () => undefined)}
          />
          <label htmlFor="diag-log">{t.keepLog}</label>
          <small id="diag-log-hint" className="muted">
            {t.keepLogHint}
          </small>
        </div>
      )}
      {diagnostics && saveFile && (
        <div className="set-actions">
          <Button variant="ghost" small disabled={saved === "busy"} onClick={() => void save()}>
            {t.saveDiagnostics}
          </Button>
          <span role="status" className="muted">
            {saved === "saved" ? t.diagnosticsSaved : saved === "cancelled" ? t.diagnosticsNotSaved : ""}
          </span>
        </div>
      )}
      {saved === "failed" && (
        <p role="alert" className="alert alert-danger">
          {t.diagnosticsFailed}
        </p>
      )}
      {children}
      {open && <DesktopFeedbackDialog onClose={() => setOpen(false)} />}
    </section>
  );
}
