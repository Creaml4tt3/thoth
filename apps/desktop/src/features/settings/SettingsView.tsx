import { useContext, useEffect, useState } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Select } from "@thoth/app-ui/ui/Select.tsx";
import { STRINGS, useStrings } from "@thoth/app-ui/strings/index.ts";
import { useSession } from "../../app/context.ts";
import { LANG_PREFERENCES, LangPreferenceContext, useDesktopStrings, type LangPreference } from "../../strings/index.ts";
import { ImportWizard } from "../import/LazyImportWizard.tsx";
import { ServersSettings } from "../servers/ServersSettings.tsx";
import { AgentSettings } from "../agents/AgentSettings.tsx";
import { NotificationSettings } from "../notifications/NotificationSettings.tsx";
import { ConnectedAppsSettings } from "../connected-apps/ConnectedAppsSettings.tsx";
import { LinkPreviewSettings } from "./LinkPreviewSettings.tsx";
import { DailySettingsSection } from "./DailySettings.tsx";
import { UpdateSettings } from "../updates/UpdateSettings.tsx";
import { usePageHost } from "@thoth/app-ui/editor/host.ts";
import { SettingsLayout, type SettingsSectionLink } from "@thoth/app-ui/ui/SettingsLayout.tsx";
import { EDITOR_MODES, defaultEditorMode, setDefaultEditorMode, type EditorMode } from "@thoth/app-ui/editor/mode.ts";
import { THEMES, useTheme } from "@thoth/app-ui/ui/theme.ts";
import { desktopTheme } from "./theme.ts";
import { currentOs, displayPath } from "./path.ts";
import { requestTour } from "../tour/store.ts";
import { FeedbackSettings } from "../feedback/Feedback.tsx";

type Rebuild = { state: "idle" } | { state: "running" } | { state: "done"; pages: number } | { state: "error"; message: string };

/**
 * Settings, most used first: Appearance (theme, language), Editor, the Private Space (its folder and search index),
 * Today (the daily notes setting), Import, Servers, the assistant, Connected apps, Notifications, Updates, and Help and feedback (with the tour).
 */
export function SettingsView({ section = "top", request }: { section?: "top" | "servers" | "agents" | "import" | "today"; request?: object }) {
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
  // Opened at Import notes (the sidebar's Import button, the palette): the wizard starts and takes focus itself.
  // `request` is the tab's target, new on every open, so asking again after closing the wizard starts it again.
  useEffect(() => {
    if (section !== "import") return;
    setImporting(true);
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
  const sections: SettingsSectionLink[] = [
    { id: "set-appearance", label: t.appearance, icon: "moon" },
    { id: "set-editor", label: t.editor, icon: "pen" },
    { id: "set-vault", label: t.privateSpace, icon: "folder" },
    { id: "set-today", label: d.daily.title, icon: "sun" },
    { id: "set-import", label: t.importExport, icon: "import" },
    { id: "set-servers", label: d.servers.title, icon: "server" },
    { id: "set-agents", label: d.agents.title, icon: "sparkle" },
    { id: "set-connected-apps", label: d.connectedApps.title, icon: "plug" },
    { id: "set-notifications", label: d.notifications.title, icon: "bell" },
    { id: "set-general", label: d.updates.general, icon: "gear" },
    { id: "set-feedback", label: d.helpFeedback.title, icon: "speech" },
  ];

  return (
    <SettingsLayout sections={sections} initial={section === "top" ? undefined : `set-${section}`} request={request}>
      <h1 className="page-title">{t.title}</h1>

      <section aria-labelledby="set-appearance" className="set-section">
        <h2 id="set-appearance">{t.appearance}</h2>
        <div className="field set-language">
          <span className="set-field-name">{t.theme}</span>
          <span id="set-theme-hint" className="muted">{t.themeHint}</span>
          <Select aria-label={t.theme} aria-describedby="set-theme-hint" value={theme} onChange={setTheme} options={THEMES.map((choice) => ({ value: choice, label: themeNames[choice] }))} />
        </div>
        <div className="field set-language">
          <span className="set-field-name">{t.language}</span>
          <span id="set-language-hint" className="muted">{t.languageHint}</span>
          {/* Each language is named in itself, so it can be found whatever the UI language is. */}
          <Select<LangPreference> aria-label={t.language} aria-describedby="set-language-hint" value={preference} onChange={setPreference} options={LANG_PREFERENCES.map((choice) => ({ value: choice, label: choice === "system" ? t.system : STRINGS[choice].name }))} />
        </div>
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

      <section aria-labelledby="set-vault" className="set-section">
        <h2 id="set-vault">{t.privateSpace}</h2>
        {/* One part for the search: the folder, its path and its buttons stay together. */}
        <div className="set-group">
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
            <Button variant="ghost" small onClick={() => void switchVault()}>
              {t.switchSpace}
            </Button>
          </div>
          {revealError && (
            <p role="alert" className="alert alert-danger">
              {revealError}
            </p>
          )}
        </div>
        <div className="set-sub">
          <h3>{t.index}</h3>
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
        </div>
      </section>

      <DailySettingsSection />

      <section aria-labelledby="set-import" className="set-section">
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

      <ServersSettings />

      <AgentSettings />

      {platform.connectedApps && <ConnectedAppsSettings connectedApps={platform.connectedApps} />}

      <NotificationSettings />

      <UpdateSettings />

      <FeedbackSettings>
        <div className="set-sub">
          <h3>{t.gettingStarted}</h3>
          <p className="muted">{t.tourNote}</p>
          <div className="set-actions">
            <Button variant="ghost" small onClick={requestTour}>
              {t.showTour}
            </Button>
          </div>
        </div>
      </FeedbackSettings>
    </SettingsLayout>
  );
}
