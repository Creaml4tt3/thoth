/**
 * `Transport` over Tauri IPC (desktop). Each contract command `a.b` is the
 * Rust command `a_b`. Request bytes travel as the raw IPC body with the JSON
 * arguments percent-encoded in the `x-thoth-args` header; byte results come
 * back as a raw `ArrayBuffer`. Host events arrive as `vault:changed` (Tauri
 * event names cannot contain "."). Exported from `@thoth/platform/tauri`.
 *
 * `@tauri-apps/api` is a dependency of the app, not of this package, so by
 * default this binds to the same `window.__TAURI_INTERNALS__` entry points
 * that `@tauri-apps/api/core#invoke` and `@tauri-apps/api/event#listen` (2.x)
 * call. The app may pass those functions instead via `createTauriPlatform(api)`.
 */
import type { Platform } from "./index.ts";
import type { CommandName, Commands, Transport, VaultChangedEvent } from "./ipc.ts";
import { HostCallError, createRemotePlatform, isHostErrorShape } from "./remote.ts";

/** Header carrying the JSON arguments when the body is raw bytes. */
export const ARGS_HEADER = "x-thoth-args";
export const VAULT_CHANGED_EVENT = "vault:changed";

export type TauriInvoke = (command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => Promise<unknown>;
export type TauriListen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

export interface TauriApi {
  invoke: TauriInvoke;
  listen: TauriListen;
}

interface TauriInternals {
  invoke: TauriInvoke;
  transformCallback(callback: (event: { payload: unknown }) => void, once?: boolean): number;
}

interface TauriGlobals {
  __TAURI_INTERNALS__?: TauriInternals;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener(event: string, eventId: number): void };
}

/** The `@tauri-apps/api` 2.x behaviour of `invoke` and `listen`, without importing it. */
export function internalsApi(globals: TauriGlobals = globalThis as TauriGlobals): TauriApi {
  const internals = (): TauriInternals => {
    const value = globals.__TAURI_INTERNALS__;
    if (!value) throw new Error("Not running inside Tauri");
    return value;
  };
  const invoke: TauriInvoke = (command, args, options) => internals().invoke(command, args ?? {}, options);
  const listen: TauriListen = async <T>(event: string, handler: (event: { payload: T }) => void) => {
    const callback = internals().transformCallback(handler as (event: { payload: unknown }) => void);
    const eventId = (await invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler: callback })) as number;
    return async () => {
      globals.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener(event, eventId);
      await invoke("plugin:event|unlisten", { event, eventId });
    };
  };
  return { invoke, listen };
}

export function tauriCommandName(command: CommandName): string {
  return command.replaceAll(".", "_");
}

function toError(error: unknown): Error {
  if (isHostErrorShape(error)) return new HostCallError(error.code, error.message);
  return error instanceof Error ? error : new HostCallError("INTERNAL", String(error));
}

export class TauriTransport implements Transport {
  private readonly api: TauriApi;

  constructor(api: TauriApi = internalsApi()) {
    this.api = api;
  }

  async call<C extends CommandName>(command: C, args: Commands[C]["args"], bytes?: Uint8Array): Promise<Commands[C]["result"]> {
    const name = tauriCommandName(command);
    let result: unknown;
    try {
      // Header values must be ISO-8859-1; percent-encoding keeps non-Latin paths intact.
      result =
        bytes === undefined
          ? await this.api.invoke(name, { args })
          : await this.api.invoke(name, bytes, { headers: { [ARGS_HEADER]: encodeURIComponent(JSON.stringify(args)) } });
    } catch (error) {
      throw toError(error);
    }
    if (result instanceof ArrayBuffer) return new Uint8Array(result) as Commands[C]["result"];
    return result as Commands[C]["result"];
  }

  async listen(_event: "vault.changed", handler: (payload: VaultChangedEvent) => void): Promise<() => void> {
    const unlisten = await this.api.listen<VaultChangedEvent>(VAULT_CHANGED_EVENT, (e) => handler(e.payload));
    return () => void unlisten();
  }
}

export function createTauriPlatform(api?: TauriApi): Platform {
  return createRemotePlatform(new TauriTransport(api), "tauri");
}
