import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { STRINGS, useStrings } from "@thoth/app-ui/strings/index.ts";
import { useSession } from "../../app/context.ts";
import { LANG_PREFERENCES, LangPreferenceContext, useDesktopStrings, type LangPreference } from "../../strings/index.ts";
import { ImportWizard } from "../import/ImportWizard.tsx";
import { ServersSettings } from "../servers/ServersSettings.tsx";
import { AgentSettings } from "../agents/AgentSettings.tsx";
import { NotificationSettings } from "../notifications/NotificationSettings.tsx";
import { ConnectedAppsSettings } from "../connected-apps/ConnectedAppsSettings.tsx";
import { LinkPreviewSettings } from "./LinkPreviewSettings.tsx";
import { UpdateSettings } from "../updates/UpdateSettings.tsx";
import { usePageHost } from "@thoth/app-ui/editor/host.ts";
import { SettingsLayout } from "@thoth/app-ui/ui/SettingsLayout.tsx";
import { EDITOR_MODES, defaultEditorMode, setDefaultEditorMode, type EditorMode } from "@thoth/app-ui/editor/mode.ts";
import { THEMES, useTheme } from "@thoth/app-ui/ui/theme.ts";
import { desktopTheme } from "./theme.ts";
import { currentOs, displayPath } from "./path.ts";
import { requestTour } from "../tour/store.ts";

type Rebuild = { state: "idle" } | { state: "running" } | { state: "done"; pages: number } | { state: "error"; message: string };

/** Settings: vault location, workspace servers, the assistant, notifications, language, editor mode, Rebuild index, and Import & Export. */
export function SettingsView({ section = "top", request }: { section?: "top" | "servers" | "agents" | "import"; request?: object }) {
  const { connection, vault, refresh, switchVault, openPage, openFolder, platform } = useSession();
  const previews = usePageHost().links;
  const t = useDesktopStrings().settings;
  const modes = useStrings().editor.modes;
  const { preference, setPreference } = useContext(LangPreferenceContext);
  const { theme, setTheme } = useTheme(desktopTheme);
  const themeNames = useStrings().theme;
  const [rebuild, setRebuild] = useState<Rebuild>({ state: "idle" });
  const [importing, setImporting] = useState(false);
  const [mode, setMode] = useState<EditorMode>(defaultEditorMode);
  const [revealError, setRevealError] = useState<string | null>(null);
  const importSection = useRef<HTMLElement>(null);
  // Opened at Import & Export (the sidebar's Import button, the palette): the wizard starts and takes focus itself.
  // `request` is the tab's target, new on every open, so asking again after closing the wizard starts it again.
  useEffect(() => {
    if (section !== "import") return;
    setImporting(true);
    importSection.current?.scrollIntoView?.({ block: "start" });
  }, [section, request]);

  const rebuildIndex = async () => {
    setRebuild({ state: "running" });
    try {
      const report = await vault.rebuildIndex();
      await refresh();
      setRebuild({ state: "done", pages: report.added.length });
    } catch (e) {
      setRebuild({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const reveal = connection.reveal?.bind(connection);
  const showFolder = async () => {
    setRevealError(null);
    try {
      await reveal?.();
    } catch (e) {
      setRevealError(e instanceof Error ? e.message : String(e));
    }
  };

  const d = useDesktopStrings();
  // Every section's heading id, in page order; the list leaves out those this build does not show.
  const sections = [
    { id: "set-vault", label: t.privateSpace },
    { id: "set-tour", label: t.gettingStarted },
    { id: "set-servers", label: d.servers.title },
    { id: "set-agents", label: d.agents.title },
    { id: "set-notifications", label: d.notifications.title },
    { id: "set-general", label: d.updates.general },
    { id: "set-connected-apps", label: d.connectedApps.title },
    { id: "set-language", label: t.language },
    { id: "set-theme", label: t.theme },
    { id: "set-editor", label: t.editor },
    { id: "set-index", label: t.index },
    { id: "set-import", label: t.importExport },
  ];

  return (
    <SettingsLayout sections={sections}>
      <h1 className="page-title">{t.title}</h1>

      <section aria-labelledby="set-vault" className="set-section">
        <h2 id="set-vault">{t.privateSpace}</h2>
        <p>
          <b>{connection.label}</b> <span className="badge badge-private">{t.local}</span>
        </p>
        {/* Short and without the user's name (screenshots); the full path is the tooltip. */}
        <p className="mono muted set-path" data-testid="vault-location" title={connection.root}>
          {displayPath(connection.root)}
        </p>
        <p className="muted">{t.vaultNote}</p>
        <div className="set-actions">
          {reveal && (
            <Button variant="ghost" small onClick={() => void showFolder()}>
              {t.reveal[currentOs()]}
            </Button>
          )}
          <Button variant="ghost" small onClick={switchVault}>
            {t.switchSpace}
          </Button>
        </div>
        {revealError && (
          <p role="alert" className="alert alert-danger">
            {revealError}
          </p>
        )}
      </section>

      <section aria-labelledby="set-tour" className="set-section">
        <h2 id="set-tour">{t.gettingStarted}</h2>
        <p className="muted">{t.tourNote}</p>
        <div className="set-actions">
          <Button variant="ghost" small onClick={requestTour}>
            {t.showTour}
          </Button>
        </div>
      </section>

      <ServersSettings focus={section === "servers"} />

      <AgentSettings focus={section === "agents"} />

      <NotificationSettings />

      <UpdateSettings />
      {platform.connectedApps && <ConnectedAppsSettings connectedApps={platform.connectedApps} />}

      <section aria-labelledby="set-language" className="set-section">
        <h2 id="set-language">{t.language}</h2>
        <label className="field set-language">
          <span>{t.languageHint}</span>
          <select className="input" value={preference} aria-label={t.language} onChange={(e) => setPreference(e.target.value as LangPreference)}>
            {LANG_PREFERENCES.map((choice) => (
              // Each language is named in itself, so it can be found whatever the UI language is.
              <option key={choice} value={choice} lang={choice === "system" ? undefined : choice}>
                {choice === "system" ? t.system : STRINGS[choice].name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section aria-labelledby="set-theme" className="set-section">
        <h2 id="set-theme">{t.theme}</h2>
        <label className="field set-language">
          <span>{t.themeHint}</span>
          <select className="input" value={theme} aria-label={t.theme} onChange={(e) => setTheme(e.target.value as (typeof THEMES)[number])}>
            {THEMES.map((choice) => (
              <option key={choice} value={choice}>
                {themeNames[choice]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section aria-labelledby="set-editor" className="set-section">
        <h2 id="set-editor">{t.editor}</h2>
        <p className="muted">{t.editorNote}</p>
        <fieldset className="mode-choices">
          <legend className="sr-only">{t.defaultMode}</legend>
          {EDITOR_MODES.map((m) => (
            <label key={m.id} className="mode-choice">
              <input
                type="radio"
                name="editor-mode"
                value={m.id}
                aria-label={modes[m.id].label}
                aria-describedby={`editor-mode-${m.id}`}
                checked={mode === m.id}
                onChange={() => {
                  setDefaultEditorMode(m.id);
                  setMode(m.id);
                }}
              />
              <b aria-hidden="true">{modes[m.id].label}</b>
              <span id={`editor-mode-${m.id}`}>{modes[m.id].hint}</span>
            </label>
          ))}
        </fieldset>
        {platform.links && <LinkPreviewSettings links={platform.links} {...(previews ? { onCleared: () => previews.clear() } : {})} />}
      </section>

      <section aria-labelledby="set-index" className="set-section">
        <h2 id="set-index">{t.index}</h2>
        <p className="muted">{t.indexNote}</p>
        <div className="set-actions">
          <Button variant="ghost" small disabled={rebuild.state === "running"} onClick={() => void rebuildIndex()}>
            {rebuild.state === "running" ? t.rebuilding : t.rebuild}
          </Button>
          <span role="status" className="muted">
            {rebuild.state === "done" ? t.rebuilt(rebuild.pages) : ""}
          </span>
        </div>
        {rebuild.state === "error" && (
          <p role="alert" className="alert alert-danger">
            {rebuild.message}
          </p>
        )}
      </section>

      <section ref={importSection} aria-labelledby="set-import" className="set-section">
        <h2 id="set-import">{t.importExport}</h2>
        {importing ? (
          <ImportWizard
            onClose={() => setImporting(false)}
            onOpenFolder={(folder) => {
              setImporting(false);
              openFolder(folder);
            }}
            onOpenPage={openPage}
          />
        ) : (
          <>
            <p className="muted">{t.importNote}</p>
            <div className="set-actions">
              <Button variant="primary" small onClick={() => setImporting(true)}>
                {t.importFrom}
              </Button>
            </div>
          </>
        )}
      </section>
    </SettingsLayout>
  );
}
