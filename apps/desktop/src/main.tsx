import { createRoot } from "react-dom/client";
import "@thoth/ui/tokens.css";
import { App } from "./app/App.tsx";
import { selectPlatform } from "./platform/select.ts";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

selectPlatform()
  .then((platform) => createRoot(container).render(<App platform={platform} />))
  .catch((error: unknown) => {
    container.textContent = `Thoth could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
