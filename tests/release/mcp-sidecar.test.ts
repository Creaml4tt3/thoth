/**
 * `thoth-mcp` ships inside the desktop app (ADR-0021 rule 1): Tauri's `externalBin` in a config merged only for the
 * release build (so `cargo test` and `tauri dev` need no built sidecar), the file name Tauri expects for each
 * target, and the release workflow building it before the installers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINARIES, sidecarPlan } from "../../scripts/build-mcp-sidecar.ts";
import { REPO } from "../ports/harness.ts";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");

describe("thoth-mcp in the desktop bundle", () => {
  it("is an external binary of the release build only", () => {
    const sidecar = JSON.parse(read("apps/desktop/src-tauri/tauri.sidecar.conf.json")) as { bundle: { externalBin: string[] } };
    expect(sidecar.bundle.externalBin).toEqual(["binaries/thoth-mcp"]);
    const main = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as { bundle: Record<string, unknown> };
    expect(main.bundle.externalBin).toBeUndefined();
    expect(read("apps/desktop/src-tauri/.gitignore")).toContain("/binaries");
  });

  it("is built under the name Tauri looks for on each target", () => {
    const universal = sidecarPlan("universal-apple-darwin", "/t");
    expect(universal.builds).toEqual([
      ["build", "--release", "--locked", "-p", "thoth-mcp", "--target", "aarch64-apple-darwin"],
      ["build", "--release", "--locked", "-p", "thoth-mcp", "--target", "x86_64-apple-darwin"],
    ]);
    expect(universal.built).toEqual(["/t/aarch64-apple-darwin/release/thoth-mcp", "/t/x86_64-apple-darwin/release/thoth-mcp"]);
    expect(universal.output).toBe(join(BINARIES, "thoth-mcp-universal-apple-darwin"));
    expect(universal.lipo).toBe(true);
    // A universal build compiles each architecture on its own, and Tauri's build script checks for that
    // architecture's sidecar then (the v0.2.0 release first failed without them).
    expect(universal.copies).toEqual([
      ["/t/aarch64-apple-darwin/release/thoth-mcp", join(BINARIES, "thoth-mcp-aarch64-apple-darwin")],
      ["/t/x86_64-apple-darwin/release/thoth-mcp", join(BINARIES, "thoth-mcp-x86_64-apple-darwin")],
    ]);
    expect(sidecarPlan("x86_64-unknown-linux-gnu", "/t").copies).toEqual([["/t/x86_64-unknown-linux-gnu/release/thoth-mcp", join(BINARIES, "thoth-mcp-x86_64-unknown-linux-gnu")]]);
    const windows = sidecarPlan("x86_64-pc-windows-msvc", "/t");
    expect(windows.output).toBe(join(BINARIES, "thoth-mcp-x86_64-pc-windows-msvc.exe"));
    expect(windows.built).toEqual(["/t/x86_64-pc-windows-msvc/release/thoth-mcp.exe"]);
    expect(sidecarPlan("x86_64-unknown-linux-gnu", "/t").output).toBe(join(BINARIES, "thoth-mcp-x86_64-unknown-linux-gnu"));
    expect(() => sidecarPlan("--target=x; rm -rf /")).toThrow();
  });

  it("is built by the release workflow before every installer", () => {
    const workflow = read(".github/workflows/release-desktop.yml");
    expect(workflow).toContain("node scripts/build-mcp-sidecar.ts ${{ matrix.sidecar }}");
    expect(workflow).toContain("tauri build --config src-tauri/tauri.sidecar.conf.json ${{ matrix.args }}");
    for (const sidecar of ["universal-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) expect(workflow).toContain(`sidecar: ${sidecar}`);
  });
});
