import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { scrollToSection } from "@thoth/app-ui/ui/SettingsLayout.tsx";
import { DEFAULT_DAILY, dailyPath, dailySettingsProblem, readDailySettings, updateDailySettings, type DailyProblem, type DailySettings } from "@thoth/local-store";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings, type DesktopStrings } from "../../strings/index.ts";

/** What the form shows for a refused setting. */
export function dailyProblemText(problem: DailyProblem, t: DesktopStrings["daily"]["problems"]): string {
  if (problem.field !== "pattern") return t[problem.field];
  return problem.kind === "token" ? t.token(problem.token) : t[problem.kind];
}

const trimSlashes = (s: string) => s.trim().replace(/^\/+|\/+$/g, "");
/** The form's fields as a setting: slashes at the ends dropped, an empty template is none. */
const settingsOf = (form: { folder: string; pattern: string; template: string }): DailySettings => ({
  folder: trimSlashes(form.folder),
  pattern: form.pattern.trim(),
  template: trimSlashes(form.template) || null,
});
const formOf = (s: DailySettings) => ({ folder: s.folder, pattern: s.pattern, template: s.template ?? "" });

/**
 * Settings → Today (ADR-0051 rules 7 and 8): the folder, the file name pattern and the template of today's page, saved
 * in `.thoth/daily.json`. Today's file name is shown as you type; a pattern Thoth cannot make is refused, with why.
 */
export function DailySettingsSection({ focus }: { focus: boolean }) {
  const { vault, refresh } = useSession();
  const t = useDesktopStrings().daily;
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const [form, setForm] = useState<{ folder: string; pattern: string; template: string } | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "saved" } | { kind: "failed"; reason: string }>({ kind: "idle" });

  useEffect(() => {
    let live = true;
    void readDailySettings(vault).then(({ settings }) => live && setForm(formOf(settings)));
    return () => {
      live = false;
    };
  }, [vault]);
  useEffect(() => {
    if (focus && section.current) scrollToSection(section.current);
  }, [focus, form === null]);

  const settings = form ? settingsOf(form) : DEFAULT_DAILY;
  const problem = dailySettingsProblem(settings);
  const save = async (next: DailySettings) => {
    try {
      await updateDailySettings(vault, () => next);
      setForm(formOf(next));
      setStatus({ kind: "saved" });
      await refresh().catch(() => undefined); // Home's Today card reads the setting again
    } catch (error) {
      setStatus({ kind: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  };
  const field = (name: "folder" | "pattern" | "template", label: string, hint: string) => (
    <label className="field">
      <span className="set-field-name">{label}</span>
      <span className="muted" id={`${id}-${name}-hint`}>
        {hint}
      </span>
      <input
        className="input mono"
        name={name}
        spellCheck={false}
        autoComplete="off"
        value={form?.[name] ?? ""}
        disabled={!form}
        aria-invalid={problem?.field === name ? true : undefined}
        aria-describedby={`${id}-${name}-hint${problem?.field === name ? ` ${id}-problem` : ""}`}
        onChange={(e) => {
          setStatus({ kind: "idle" });
          setForm((f) => f && { ...f, [name]: e.target.value });
        }}
      />
    </label>
  );

  return (
    <section ref={section} aria-labelledby="set-today" className="set-section">
      <h2 id="set-today">{t.title}</h2>
      <p className="muted">{t.note}</p>
      <form
        className="set-group set-daily"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) void save(settings);
        }}
      >
        {field("folder", t.folder, t.folderHint)}
        {field("pattern", t.pattern, t.patternHint)}
        {field("template", t.template, t.templateHint)}
        {problem ? (
          <p id={`${id}-problem`} role="alert" className="alert alert-danger">
            {dailyProblemText(problem, t.problems)}
          </p>
        ) : (
          <p className="mono set-path" aria-live="polite">
            {t.preview(dailyPath(settings, new Date()))}
          </p>
        )}
        <div className="set-actions">
          <Button type="submit" variant="primary" small disabled={!form || problem !== null}>
            {t.save}
          </Button>
          <Button variant="ghost" small disabled={!form} onClick={() => void save(DEFAULT_DAILY)}>
            {t.reset}
          </Button>
          <span role="status" className="muted">
            {status.kind === "saved" ? t.saved : ""}
          </span>
        </div>
        {status.kind === "failed" && (
          <p role="alert" className="alert alert-danger">
            {t.saveFailed(status.reason)}
          </p>
        )}
      </form>
    </section>
  );
}

/**
 * The one-time question (ADR-0051 rule 11, option C): this folder has Obsidian's daily notes setting and no Thoth one
 * yet. "Use it" saves Obsidian's values, "Keep Thoth's" saves the defaults; either way it is never asked again here.
 * A file name Thoth cannot make is shown with the reason, and then only "Keep Thoth's" and "Choose in Settings" are
 * offered (the latter saves the defaults too, then opens Settings → Today).
 */
export function ObsidianDailyQuestion({ found, onDone }: { found: DailySettings; onDone: (next: "settings" | null) => void }) {
  const { vault } = useSession();
  const t = useDesktopStrings().daily;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = dailySettingsProblem(found);
  const answer = (settings: DailySettings, next: "settings" | null) => {
    setBusy(true);
    // Another window may have answered meanwhile: its answer stands.
    void updateDailySettings(vault, (_, exists) => (exists ? null : settings)).then(
      () => onDone(next),
      (error: unknown) => {
        setBusy(false);
        setFailure(t.saveFailed(error instanceof Error ? error.message : String(error)));
      },
    );
  };
  return (
    <Modal title={t.obsidian.title}>
      <p>{t.obsidian.ask(found.folder || t.obsidian.topLevel)}</p>
      <dl className="daily-found">
        <dt>{t.obsidian.folder}</dt>
        <dd className="mono">{found.folder || t.obsidian.topLevel}</dd>
        <dt>{t.obsidian.pattern}</dt>
        <dd className="mono">{found.pattern}</dd>
        <dt>{t.obsidian.template}</dt>
        <dd className="mono">{found.template ?? t.obsidian.none}</dd>
      </dl>
      {problem ? <p className="alert alert-warning">{t.obsidian.cannot(dailyProblemText(problem, t.problems))}</p> : <p className="muted">{t.obsidian.once}</p>}
      {failure && (
        <p role="alert" className="alert alert-danger">
          {failure}
        </p>
      )}
      <div className="set-actions">
        {problem ? (
          <Button variant="primary" small disabled={busy} data-autofocus onClick={() => answer(DEFAULT_DAILY, "settings")}>
            {t.obsidian.choose}
          </Button>
        ) : (
          <Button variant="primary" small disabled={busy} data-autofocus onClick={() => answer(found, null)}>
            {t.obsidian.use}
          </Button>
        )}
        <Button variant="ghost" small disabled={busy} onClick={() => answer(DEFAULT_DAILY, null)}>
          {t.obsidian.keep}
        </Button>
      </div>
    </Modal>
  );
}
