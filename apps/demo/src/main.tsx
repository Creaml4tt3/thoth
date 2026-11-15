import { arm } from "./gate.ts";

arm({
  document,
  window,
  connection: (navigator as Navigator & { connection?: { saveData?: boolean } }).connection,
  // If the bundle cannot load, the capture stays and the button can try again.
  load: (root) => void import("./mount.tsx").then((m) => m.mount(root)).catch(() => delete root.dataset["thothDemoState"]),
});
