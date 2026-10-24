import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The bundled fonts' SIL Open Font License texts, which must travel with the fonts (OFL 1.1 condition 2). */
const FONT_LICENSES = ["OFL-Inter.txt", "OFL-NotoSansThai.txt"];

function fontLicenses(): Plugin {
  return {
    name: "thoth-font-licenses",
    apply: "build",
    generateBundle() {
      for (const name of FONT_LICENSES) {
        this.emitFile({ type: "asset", fileName: `fonts/${name}`, source: readFileSync(new URL(`./src/fonts/${name}`, import.meta.url)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), fontLicenses()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "safari15" },
});
