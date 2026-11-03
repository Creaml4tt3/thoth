/**
 * A release sets one version in four files (docs/deploy/release.md step 1). The server reports its package.json
 * version in GET /capabilities, so it must move with the app; this test and server-image.yml refuse a mismatch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "../ports/harness.ts";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");

describe("release versions", () => {
  it("are the same in the desktop app, its Tauri and Cargo files, and the server", () => {
    const tauri = (JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as { version: string }).version;
    expect({
      desktop: (JSON.parse(read("apps/desktop/package.json")) as { version: string }).version,
      cargo: /^version = "([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1],
      server: (JSON.parse(read("apps/server/package.json")) as { version: string }).version,
    }).toEqual({ desktop: tauri, cargo: tauri, server: tauri });
  });
});
