// @vitest-environment jsdom
/**
 * Settings → Modules (ADR-0055): OCR's two choices with their sizes, Download with progress and Cancel, a plain line for
 * each failure, the model update offer, the automatic-update switch, and "not available in this build". The host is a
 * fake that answers like `module.*`; the host's own rules are tested in Rust.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleJob, ModuleStatus, Modules, OcrModel } from "@thoth/platform";
import { cleanup, openApp, screen, waitFor, within, type Harness, openSettingsAt } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { initialTabs, serializeTabs } from "@thoth/app-ui/tabs/model.ts";
import { tabsKey } from "../src/app/tabs-store.ts";

const MB = 1_048_576;

/** Answers like the host's `module.*` commands and keeps the calls. */
class FakeModules implements Modules {
  calls: string[] = [];
  state: ModuleStatus = {
    available: true,
    runtime: null,
    models: [
      { id: "fast", installed: null, update: null, downloadSize: 21 * MB, size: 0 },
      { id: "second", installed: null, update: null, downloadSize: 27 * MB, size: 0 },
    ],
    autoUpdate: false,
    job: { state: "idle" },
  };
  listeners = new Set<(s: ModuleStatus) => void>();
  emit(change: Partial<ModuleStatus>) {
    this.state = { ...this.state, ...change };
    for (const l of this.listeners) l(this.state);
  }
  job(job: ModuleJob) {
    this.emit({ job });
  }
  async status(options?: { refresh?: boolean }) {
    this.calls.push(options?.refresh ? "status:refresh" : "status");
    return this.state;
  }
  async install(model: OcrModel) {
    this.calls.push(`install:${model}`);
    this.state = { ...this.state, job: { state: "downloading", model, received: 0, total: null } };
    return this.state;
  }
  async cancel() {
    this.calls.push("cancel");
    return this.state;
  }
  async remove(model: OcrModel) {
    this.calls.push(`remove:${model}`);
    return this.state;
  }
  async setAutoUpdate(on: boolean) {
    this.calls.push(`auto:${on}`);
    this.state = { ...this.state, autoUpdate: on };
    return this.state;
  }
  async read(): Promise<never> {
    throw new Error("not in these tests");
  }
  async cancelRead() {}
  async onProgress(listener: (s: ModuleStatus) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  async onReadProgress() {
    return () => undefined;
  }
}

const dirs = tempDirs();
let root: string;
let modules: FakeModules;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Notes.md": "# Notes\n" });
  modules = new FakeModules();
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function open(): Promise<Harness> {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, modules }));
  await screen.findByRole("tree");
  await openSettingsAt(app, "Modules");
  await screen.findByRole("heading", { name: "OCR (Thai and English)" });
  return app;
}

const row = (name: string) => screen.getByRole("group", { name });

describe("Settings → Modules", () => {
  it("shows both choices with their sizes", async () => {
    await open();
    expect(screen.getByText(/images and PDFs never leave this computer/i)).toBeTruthy();
    expect(within(row("Fast (recommended)")).getByText("Download (21.0 MB)")).toBeTruthy();
    expect(within(row("Second opinion")).getByText("Download (27.0 MB)")).toBeTruthy();
    expect(modules.calls).toContain("status:refresh");
  });

  it("download shows progress and cancel stops it", async () => {
    const app = await open();
    await app.user.click(within(row("Fast (recommended)")).getByRole("button", { name: /Download/ }));
    expect(modules.calls).toContain("install:fast");
    modules.job({ state: "downloading", model: "fast", received: 5 * MB, total: 20 * MB });
    const bar = await within(row("Fast (recommended)")).findByRole("progressbar", { name: "Download progress" });
    expect(bar.getAttribute("value")).toBe(String(5 * MB));
    expect(within(row("Fast (recommended)")).getByText("25% (5.0 MB of 20.0 MB)")).toBeTruthy();
    // One download at a time: the other choice waits.
    expect((within(row("Second opinion")).getByRole("button", { name: /Download/ }) as HTMLButtonElement).disabled).toBe(true);
    await app.user.click(within(row("Fast (recommended)")).getByRole("button", { name: "Cancel" }));
    expect(modules.calls).toContain("cancel");
  });

  it("each failure reason has its own words", async () => {
    await open();
    const seen = new Set<string>();
    for (const reason of ["offline", "verify", "disk", "cancelled", "failed", "test"] as const) {
      modules.job({ state: "failed", model: "second", reason });
      const alert = await within(row("Second opinion")).findByRole(reason === "cancelled" ? "status" : "alert");
      await waitFor(() => expect(alert.textContent).not.toBe(""));
      seen.add(alert.textContent!);
    }
    expect(seen.size).toBe(6);
  });

  it("offers the update and installs it", async () => {
    modules.state.runtime = "0.1.0";
    modules.state.models[0] = { id: "fast", installed: "openthai-2.1", update: "openthai-2.2", downloadSize: 6 * MB, size: 7 * MB };
    const app = await open();
    const fast = row("Fast (recommended)");
    expect(within(fast).getByText("A better model is ready (6.0 MB)")).toBeTruthy();
    expect(within(fast).getByText("Uses 7.0 MB")).toBeTruthy();
    await app.user.click(within(fast).getByRole("button", { name: "Remove" }));
    expect(modules.calls).toContain("remove:fast");
    await app.user.click(within(fast).getByRole("button", { name: "Update" }));
    expect(modules.calls).toContain("install:fast");
  });

  it("the auto-update switch calls module.settings", async () => {
    const app = await open();
    const toggle = screen.getByRole("switch", { name: "Update OCR models automatically" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await app.user.click(toggle);
    await waitFor(() => expect(modules.calls).toContain("auto:true"));
    expect(toggle.checked).toBe(true);
  });

  it("not available in this build shows no buttons", async () => {
    modules.state = { available: false, runtime: null, models: [], autoUpdate: false, job: { state: "idle" } };
    await open();
    expect(screen.getByText("OCR isn't available in this build.")).toBeTruthy();
    const section = screen.getByRole("heading", { name: "OCR (Thai and English)" }).closest("section")!;
    expect(within(section).queryAllByRole("button")).toHaveLength(0);
    expect(within(section).queryByRole("switch")).toBeNull();
  });

  it("the deep link opens the Modules section", async () => {
    // What openSettings("modules") opens: a settings tab at that section (here restored from a stored tab).
    localStorage.setItem(tabsKey(root), serializeTabs(initialTabs([{ kind: "settings", section: "modules" }])));
    await openApp(root, {}, createNodePlatform({ vault: root, modules }));
    const tab = await screen.findByRole("tab", { name: "Modules" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("tabpanel", { name: "Modules" })).toBeTruthy();
  });
});
