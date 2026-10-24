import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collect, describe as describeFile, sha256sums } from "../../scripts/publish-downloads.ts";

describe("installer names", () => {
  it.each([
    ["Thoth_0.1.0_universal.dmg", { version: "0.1.0", platform: "macos", kind: "dmg", arch: "universal" }],
    ["Thoth_0.1.0_aarch64.dmg", { platform: "macos", arch: "arm64" }],
    ["Thoth_0.1.0_x64-setup.exe", { platform: "windows", kind: "exe", arch: "x64" }],
    ["Thoth_0.1.0_x64_en-US.msi", { platform: "windows", kind: "msi", arch: "x64" }],
    ["Thoth_0.1.0_amd64.AppImage", { platform: "linux", kind: "appimage", arch: "x64" }],
    ["Thoth_0.1.0_amd64.deb", { platform: "linux", kind: "deb", arch: "x64" }],
    ["Thoth_0.2.0-beta.1_universal.dmg", { version: "0.2.0-beta.1" }],
  ])("%s", (file, expected) => {
    expect(describeFile(file)).toMatchObject({ file, ...expected });
  });
  it("refuses anything that is not a Thoth installer", () => {
    for (const bad of ["notes.dmg", "Thoth_0.1.0_universal.zip", "Thoth_latest_x64.msi", "Thoth_0.1.0_sparc.deb"]) expect(() => describeFile(bad), bad).toThrow();
  });
});

describe("release manifest", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const folder = async (files: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), "thoth-release-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
    return dir;
  };

  it("lists each installer with its size and SHA-256, ignores other files, and writes sha256sum lines", async () => {
    const dir = await folder({ "Thoth_0.1.0_universal.dmg": "mac", "Thoth_0.1.0_amd64.deb": "linux!", "README.txt": "ignored" });
    const release = await collect(dir, "2026-10-24");
    expect(release).toMatchObject({ version: "0.1.0", date: "2026-10-24", base: "https://download.thoth.creaml4tt3.me/v0.1.0/" });
    expect(release.files.map((f) => [f.file, f.bytes])).toEqual([["Thoth_0.1.0_amd64.deb", 6], ["Thoth_0.1.0_universal.dmg", 3]]);
    expect(release.files[1]!.sha256).toBe("348a629f5ceed032c3e8706ec47d9bfafb00fb4250b018dd965435ca50cb836e"); // sha256("mac")
    expect(sha256sums(release)).toBe(release.files.map((f) => `${f.sha256}  ${f.file}\n`).join(""));
  });

  it("refuses an empty folder and mixed versions", async () => {
    await expect(collect(await folder({ "notes.txt": "x" }), "2026-10-24")).rejects.toThrow(/no installers/);
    await expect(collect(await folder({ "Thoth_0.1.0_universal.dmg": "a", "Thoth_0.1.1_amd64.deb": "b" }), "2026-10-24")).rejects.toThrow(/mixed versions/);
  });
});
