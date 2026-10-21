/** `TauriTransport` framing against a fake Tauri API: command names, raw bytes, args header, errors and events. */
import { describe, expect, it } from "vitest";
import { HostCallError } from "@thoth/platform/remote";
import { ARGS_HEADER, TauriTransport, VAULT_CHANGED_EVENT, internalsApi, type TauriApi } from "@thoth/platform/tauri";

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
