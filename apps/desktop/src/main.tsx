import { createRoot } from "react-dom/client";
import "@thoth/ui/tokens.css";
import "./fonts/fonts.css";
import "./features/settings/theme.ts"; // applies the saved theme before the first render
import { App } from "./app/App.tsx";
import { readLaunch } from "./app/windows.ts";
import { selectPlatform } from "./platform/select.ts";
import { selectNotifier } from "./platform/notifier.ts";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

selectPlatform()
  // A window the app opened says which it is, and what it shows, in its address (ADR-0019).
  .then((platform) => createRoot(container).render(<App platform={platform} launch={readLaunch(window.location.search)} options={{ notifier: selectNotifier() }} />))
  .catch((error: unknown) => {
    container.textContent = `Thoth could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
