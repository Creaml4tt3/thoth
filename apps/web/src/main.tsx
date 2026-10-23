import { createRoot } from "react-dom/client";
import "@thoth/ui/tokens.css";
import "./fonts.css";
import "./web.css";
import { App } from "./App.tsx";
import { browserEnv } from "./env.ts";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");
createRoot(container).render(<App env={browserEnv()} />);
