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
import type { ConnectedApps, Platform, Windows } from "./index.ts";
import type { CommandName, Commands, InstallState, McpRequest, Transport, VaultChangedEvent } from "./ipc.ts";
import { HostCallError, createRemotePlatform, isHostErrorShape, remoteConnectedApps, remoteUpdates } from "./remote.ts";

/** Header carrying the JSON arguments when the body is raw bytes. */
export const ARGS_HEADER = "x-thoth-args";
export const VAULT_CHANGED_EVENT = "vault:changed";
/** Sent by the shell to the other windows when the user closes one (ADR-0019). */
export const WINDOW_CLOSED_EVENT = "thoth:window-closed";
/** Sent by the shell to a window whose close button (or Quit) was used: write the edits, then `window_close` (ADR-0019). */
export const CLOSE_REQUESTED_EVENT = "thoth:close-requested";
/** Connected apps (ADR-0021): a request for one window to answer, and the apps waiting for Allow or Deny. */
export const MCP_REQUEST_EVENT = "thoth:mcp-request";
export const MCP_PENDING_EVENT = "thoth:mcp-pending";
/** In-app updates (ADR-0034): the host's `update.progress`. */
export const UPDATE_PROGRESS_EVENT = "thoth:update-progress";

export type TauriInvoke = (command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => Promise<unknown>;
export type TauriListen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

export interface TauriApi {
  invoke: TauriInvoke;
  listen: TauriListen;
  /** This window's label. A listener hears events sent to any window, so events meant for one window name it. */
  label?(): string | undefined;
}

interface TauriInternals {
  invoke: TauriInvoke;
  transformCallback(callback: (event: { payload: unknown }) => void, once?: boolean): number;
  metadata?: { currentWindow?: { label?: string } };
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
  return { invoke, listen, label: () => globals.__TAURI_INTERNALS__?.metadata?.currentWindow?.label };
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

/** Thoth's own windows (ADR-0019): the shell's `window_open` and `window_close`, and its window-closed event. */
export function tauriWindows(api: TauriApi = internalsApi()): Windows {
  return {
    async open(request) {
      try {
        await api.invoke("window_open", { args: request });
      } catch (error) {
        throw toError(error);
      }
    },
    async closeThis(options) {
      try {
        return (await api.invoke("window_close", { args: options?.evenIfLast === true ? { evenIfLast: true } : {} })) === true;
      } catch (error) {
        throw toError(error);
      }
    },
    async onClosed(listener) {
      const unlisten = await api.listen<string>(WINDOW_CLOSED_EVENT, (e) => listener(e.payload));
      return () => void unlisten();
    },
    async onCloseRequested(listener) {
      // Every window hears the request; only the one it names answers (the shell also refuses any other answer).
      const unlisten = await api.listen<string | null>(CLOSE_REQUESTED_EVENT, (e) => {
        const mine = api.label?.();
        if (typeof e.payload === "string" && mine !== undefined && e.payload !== mine) return;
        listener();
      });
      return () => void unlisten();
    },
  };
}

/** Connected apps (ADR-0021): the `mcp.*` commands and the shell's two events for them. */
export function tauriConnectedApps(transport: Transport, api: TauriApi = internalsApi()): ConnectedApps {
  return remoteConnectedApps(transport, {
    async onRequest(listener) {
      const unlisten = await api.listen<McpRequest>(MCP_REQUEST_EVENT, (e) => listener(e.payload));
      return () => void unlisten();
    },
    async onPending(listener) {
      const unlisten = await api.listen<{ apps: string[] }>(MCP_PENDING_EVENT, (e) => listener(e.payload.apps));
      return () => void unlisten();
    },
  });
}

export function createTauriPlatform(api?: TauriApi): Platform {
  const transport = new TauriTransport(api);
  const bound = api ?? internalsApi();
  const updates = remoteUpdates(transport, {
    async onProgress(listener) {
      const unlisten = await bound.listen<InstallState>(UPDATE_PROGRESS_EVENT, (e) => listener(e.payload));
      return () => void unlisten();
    },
  });
  return { ...createRemotePlatform(transport, "tauri"), updates, windows: tauriWindows(api), connectedApps: tauriConnectedApps(transport, api) };
}
