import { createRoot } from "react-dom/client";
import "@thoth/ui/tokens.css";
import "./fonts/fonts.css";
import "./features/settings/theme.ts"; // applies the saved theme before the first render
import { App } from "./app/App.tsx";
import { readLaunch } from "./app/windows.ts";
import { selectPlatform } from "./platform/select.ts";
import { selectNotifier } from "./platform/notifier.ts";
import { createErrorReporter } from "./platform/errors.ts";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

// Files dropped from the system reach the page (ADR-0028): a page takes image files; a file dropped anywhere else
// must never make the window open it in place of the app.
const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
window.addEventListener("dragover", (event) => {
  if (carriesFiles(event) && !event.defaultPrevented) {
    event.preventDefault();
    event.dataTransfer!.dropEffect = "none";
  }
});
window.addEventListener("drop", (event) => {
  if (carriesFiles(event)) event.preventDefault();
});

selectPlatform()
  // A window the app opened says which it is, and what it shows, in its address (ADR-0019).
  .then((platform) => {
    // Uncaught errors go to the host's local log, never anywhere else (ADR-0040).
    if (platform.diagnostics) {
      const report = createErrorReporter(platform.diagnostics.report);
      window.addEventListener("error", report);
      window.addEventListener("unhandledrejection", report);
    }
    return platform;
  })
  .then((platform) => createRoot(container).render(<App platform={platform} launch={readLaunch(window.location.search)} options={{ notifier: selectNotifier() }} />))
  .catch((error: unknown) => {
    container.textContent = `Thoth could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
