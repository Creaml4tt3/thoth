/** `TauriTransport` framing against a fake Tauri API: command names, raw bytes, args header, errors and events. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostCallError } from "@thoth/platform/remote";
import { ARGS_HEADER, CLOSE_REQUESTED_EVENT, TauriTransport, VAULT_CHANGED_EVENT, WINDOW_CLOSED_EVENT, createTauriPlatform, internalsApi, tauriWindows, type TauriApi } from "@thoth/platform/tauri";

function fakeApi(reply: (command: string, args: unknown, options?: { headers: Record<string, string> }) => unknown): { api: TauriApi; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    api: {
      invoke: async (command, args, options) => {
        calls.push([command, args, options]);
        return reply(command, args, options);
      },
      listen: async (event, handler) => {
        calls.push(["listen", event]);
        handler({ payload: { vault: "v", paths: ["a.md"], rescan: false } as never });
        return () => undefined;
      },
    },
  };
}

describe("TauriTransport", () => {
  it("maps commands, sends JSON args, raw bytes with a percent-encoded args header, and returns raw bytes", async () => {
    const { api, calls } = fakeApi((command) => (command === "fs_read" ? new Uint8Array([1, 2]).buffer : null));
    const t = new TauriTransport(api);
    expect(await t.call("fs.read", { vault: "v", path: "ก.md" })).toEqual(new Uint8Array([1, 2]));
    await t.call("fs.write", { vault: "v", path: "ก.md", exclusive: true }, new Uint8Array([9]));
    expect(calls[0]).toEqual(["fs_read", { args: { vault: "v", path: "ก.md" } }, undefined]);
    const [name, body, options] = calls[1] as [string, Uint8Array, { headers: Record<string, string> }];
    expect(name).toBe("fs_write");
    expect(body).toEqual(new Uint8Array([9]));
    expect(JSON.parse(decodeURIComponent(options.headers[ARGS_HEADER]!))).toEqual({ vault: "v", path: "ก.md", exclusive: true });
    expect(/^[\x20-\x7e]*$/.test(options.headers[ARGS_HEADER]!)).toBe(true);
  });

  it("re-throws host errors with their code and forwards vault.changed events", async () => {
    const { api, calls } = fakeApi(() => {
      throw { code: "EEXIST", message: "exists" };
    });
    const t = new TauriTransport(api);
    const error = await t.call("fs.mkdirp", { vault: "v", dir: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostCallError);
    expect(error).toMatchObject({ code: "EEXIST", message: "exists" });
    const seen: unknown[] = [];
    await t.listen("vault.changed", (p) => seen.push(p));
    expect(calls).toContainEqual(["listen", VAULT_CHANGED_EVENT]);
    expect(seen).toEqual([{ vault: "v", paths: ["a.md"], rescan: false }]);
  });

  it("sends link previews, clearing and opening to the host's link commands (ADR-0020)", async () => {
    const preview = { url: "https://a.example/", finalUrl: "https://a.example/", title: "A" };
    const { api, calls } = fakeApi((command) => (command === "link_preview" ? preview : null));
    const links = createTauriPlatform(api).links!;
    expect(await links.preview("https://a.example/")).toEqual(preview);
    await links.clearPreviews();
    await links.open("https://a.example/x");
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      ["link_preview", { args: { url: "https://a.example/" } }],
      ["link_preview_clear", { args: {} }],
      ["link_open", { args: { url: "https://a.example/x" } }],
    ]);
    const shell = readFileSync(join(import.meta.dirname, "../../crates/thoth-host/src/lib.rs"), "utf8");
    expect(shell).toContain(`"link.preview", "link.preview.clear", "link.open",`);
  });

  it("binds to window.__TAURI_INTERNALS__ like @tauri-apps/api", async () => {
    const invoked: unknown[][] = [];
    const api = internalsApi({
      __TAURI_INTERNALS__: {
        invoke: async (command, args, options) => {
          invoked.push([command, args, options]);
          return command === "plugin:event|listen" ? 7 : null;
        },
        transformCallback: () => 42,
      },
    });
    const unlisten = await api.listen(VAULT_CHANGED_EVENT, () => undefined);
    expect(invoked[0]).toEqual(["plugin:event|listen", { event: "vault:changed", target: { kind: "Any" }, handler: 42 }, undefined]);
    await unlisten();
    expect(invoked[1]).toEqual(["plugin:event|unlisten", { event: "vault:changed", eventId: 7 }, undefined]);
  });
});

describe("Thoth's windows over Tauri (ADR-0019)", () => {
  it("opens a window with the shell's own command, asks it to close this one, and hears when another closes", async () => {
    const calls: unknown[][] = [];
    const heard: string[] = [];
    let closedHandler: ((event: { payload: unknown }) => void) | undefined;
    const api: TauriApi = {
      invoke: async (command, args) => {
        calls.push([command, args]);
        if (command === "window_close") return true;
        if (command === "window_open" && (args as { args: { id: string } }).args.id === "space-taken") throw { code: "BAD_ARGUMENT", message: "That window is open already" };
        return null;
      },
      listen: async (event, handler) => {
        calls.push(["listen", event]);
        closedHandler = handler as (event: { payload: unknown }) => void;
        return () => undefined;
      },
    };
    const windows = tauriWindows(api);
    await windows.open({ id: "space-ab12", root: "/Notes", tabs: "{}", at: { x: 1, y: 2 } });
    expect(calls[0]).toEqual(["window_open", { args: { id: "space-ab12", root: "/Notes", tabs: "{}", at: { x: 1, y: 2 } } }]);
    await expect(windows.open({ id: "space-taken", root: "/Notes", tabs: "{}" })).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    expect(await windows.closeThis()).toBe(true);
    expect(calls[2]).toEqual(["window_close", { args: {} }]);
    await windows.onClosed((id) => heard.push(id));
    expect(calls).toContainEqual(["listen", WINDOW_CLOSED_EVENT]);
    closedHandler!({ payload: "space-ab12" });
    expect(heard).toEqual(["space-ab12"]);
    expect(createTauriPlatform(api).windows).toBeDefined();
  });

  it("listens to the events under the names the desktop shell sends them by", () => {
    const shell = readFileSync(join(import.meta.dirname, "../../apps/desktop/src-tauri/src/lib.rs"), "utf8");
    expect(shell).toContain(`pub const WINDOW_CLOSED_EVENT: &str = "${WINDOW_CLOSED_EVENT}";`);
    expect(shell).toContain(`pub const CLOSE_REQUESTED_EVENT: &str = "${CLOSE_REQUESTED_EVENT}";`);
  });

  it("hears its close button and then closes itself, even as the last window", async () => {
    const calls: unknown[][] = [];
    let requested: ((event: { payload: unknown }) => void) | undefined;
    const api: TauriApi = {
      invoke: async (command, args) => {
        calls.push([command, args]);
        return true;
      },
      listen: async (event, handler) => {
        calls.push(["listen", event]);
        requested = handler as (event: { payload: unknown }) => void;
        return () => undefined;
      },
    };
    const windows = tauriWindows(api);
    let asked = 0;
    await windows.onCloseRequested(() => asked++);
    expect(calls).toEqual([["listen", CLOSE_REQUESTED_EVENT]]);
    requested!({ payload: null });
    expect(asked).toBe(1);
    expect(await windows.closeThis({ evenIfLast: true })).toBe(true);
    expect(calls[1]).toEqual(["window_close", { args: { evenIfLast: true } }]);
  });
});
