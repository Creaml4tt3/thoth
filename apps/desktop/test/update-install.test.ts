/**
 * In-app updates in the window's update service (ADR-0034): Update asks the host to download; the host's progress
 * events are the state every window shows; "Restart now" writes this window's edits first and does not restart when a
 * save fails; an assistant run going makes the host answer `busy`, and the person chooses.
 */
import { describe, expect, it } from "vitest";
import type { InstallState, RestartAnswer, UpdateCheck, UpdateSettings, Updates } from "@thoth/platform";
import { createUpdateService } from "../src/features/updates/service.ts";

class Host implements Updates {
  calls: string[] = [];
  listeners = new Set<(s: InstallState) => void>();
  state: InstallState = { phase: "idle" };
  restartAnswer: RestartAnswer = { state: "restarting" };
  answer: UpdateCheck = { state: "available", checkedAt: 1, update: { version: "0.2.4", downloadUrl: "https://thothnotes.com/#download", skipped: false, inApp: true } };
  async check() {
    return this.answer;
  }
  private settingsNow(): UpdateSettings {
    return { available: true, current: "0.2.3", notify: true, install: true, canInstall: true, skipped: null, lastChecked: null };
  }
  async settings() {
    return this.settingsNow();
  }
  async setNotify() {
    return this.settingsNow();
  }
  async skip() {
    return this.settingsNow();
  }
  async setInstall() {
    return this.settingsNow();
  }
  async install() {
    this.calls.push("install");
    return (this.state = { phase: "downloading", received: 0 });
  }
  async cancel() {
    this.calls.push("cancel");
    return this.state;
  }
  async status() {
    return this.state;
  }
  async restart(options?: { evenIfRunning?: boolean }) {
    this.calls.push(options?.evenIfRunning ? "restart anyway" : "restart");
    return options?.evenIfRunning ? { state: "restarting" as const } : this.restartAnswer;
  }
  async onProgress(listener: (s: InstallState) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  emit(state: InstallState) {
    this.state = state;
    for (const l of this.listeners) l(state);
  }
}

async function ready(flush: () => Promise<boolean> = async () => true) {
  const host = new Host();
  const service = createUpdateService(host, undefined, { delayMs: 0, intervalMs: 3_600_000, flush });
  const stop = service.start();
  await service.checkNow();
  return { host, service, stop };
}

describe("the update service, in the app", () => {
  it("downloads only when Update is clicked, and shows the host's progress", async () => {
    const { host, service, stop } = await ready();
    expect(service.getState().offer?.inApp).toBe(true);
    expect(host.calls).toEqual([]);
    await service.update();
    expect(host.calls).toEqual(["install"]);
    host.emit({ phase: "downloading", received: 5, total: 10 });
    expect(service.getState().install).toEqual({ phase: "downloading", received: 5, total: 10 });
    await service.cancel();
    expect(host.calls).toEqual(["install", "cancel"]);
    stop();
  });

  it("shows the popup again when the update is ready or fails, even after Later", async () => {
    const { host, service, stop } = await ready();
    await service.update();
    service.later();
    expect(service.getState().offer).toBeNull();
    host.emit({ phase: "ready", version: "0.2.4", installed: true });
    expect(service.getState().offer?.version).toBe("0.2.4");
    service.later();
    host.emit({ phase: "failed", reason: "verify" });
    expect(service.getState().offer?.version).toBe("0.2.4");
    stop();
  });

  it("Restart now writes this window's edits first, then asks the host", async () => {
    const order: string[] = [];
    const { host, service, stop } = await ready(async () => (order.push("flush"), true));
    host.emit({ phase: "ready", version: "0.2.4", installed: true });
    await service.restart();
    order.push(...host.calls);
    expect(order).toEqual(["flush", "restart"]);
    expect(service.getState().problem).toBeNull();
    stop();
  });

  it("does not restart when a save fails, and says so", async () => {
    const { host, service, stop } = await ready(async () => false);
    host.emit({ phase: "ready", version: "0.2.4", installed: true });
    await service.restart();
    expect(host.calls).toEqual([]);
    expect(service.getState().problem).toEqual({ kind: "save" });
    // A flush that throws is a failed save too.
    const broken = await ready(async () => Promise.reject(new Error("disk")));
    broken.host.emit({ phase: "ready", version: "0.2.4", installed: true });
    await broken.service.restart();
    expect(broken.host.calls).toEqual([]);
    expect(broken.service.getState().problem).toEqual({ kind: "save" });
    stop();
    broken.stop();
  });

  it("lets the person choose while an assistant run is going", async () => {
    const { host, service, stop } = await ready();
    host.restartAnswer = { state: "busy", runs: 2 };
    host.emit({ phase: "ready", version: "0.2.4", installed: false });
    await service.restart();
    expect(service.getState().problem).toEqual({ kind: "busy", runs: 2 });
    await service.restart({ evenIfRunning: true });
    expect(host.calls).toEqual(["restart", "restart anyway"]);
    expect(service.getState().problem).toBeNull();
    stop();
  });

  it("a window opened while an update downloads shows it", async () => {
    const host = new Host();
    host.state = { phase: "downloading", received: 3, total: 9 };
    const service = createUpdateService(host, undefined, { delayMs: 3_600_000, intervalMs: 3_600_000 });
    const stop = service.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(service.getState().install).toEqual({ phase: "downloading", received: 3, total: 9 });
    stop();
    // Stopped: no more events reach it.
    host.emit({ phase: "idle" });
    expect(service.getState().install.phase).toBe("downloading");
  });
});
