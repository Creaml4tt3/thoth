import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collect, describe as describeFile, sha256sums, updaterUploads } from "../../scripts/publish-downloads.ts";

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
    const dir = await folder({ "Thoth_0.1.0_universal.dmg": "mac", "Thoth_0.1.0_amd64.deb": "linux!", "README.txt": "ignored", ...SIGNED(["Thoth_0.1.0_universal.app.tar.gz"]) });
    const release = await collect(dir, "2026-10-24");
    expect(release).toMatchObject({ version: "0.1.0", date: "2026-10-24", base: "https://download.thothnotes.com/v0.1.0/" });
    // The update popup's "What's new" link (ADR-0022): the version's entry on the website's changelog page.
    expect(release.notes).toBe("https://thothnotes.com/changelog/#v0-1-0");
    expect(release.files.map((f) => [f.file, f.bytes])).toEqual([["Thoth_0.1.0_amd64.deb", 6], ["Thoth_0.1.0_universal.dmg", 3]]);
    expect(release.files[1]!.sha256).toBe("348a629f5ceed032c3e8706ec47d9bfafb00fb4250b018dd965435ca50cb836e"); // sha256("mac")
    expect(sha256sums(release)).toBe(release.files.map((f) => `${f.sha256}  ${f.file}\n`).join(""));
  });

  it("refuses an empty folder and mixed versions", async () => {
    await expect(collect(await folder({ "notes.txt": "x" }), "2026-10-24")).rejects.toThrow(/no installers/);
    await expect(collect(await folder({ "Thoth_0.1.0_universal.dmg": "a", "Thoth_0.1.1_amd64.deb": "b", ...SIGNED(["Thoth_0.1.0_universal.app.tar.gz"]) }), "2026-10-24")).rejects.toThrow(/mixed versions/);
  });
});

/** A `.sig` file as `tauri build` writes it: base64 of the two-line minisign signature text. */
const sig = (file: string) => Buffer.from(`untrusted comment: signature from tauri secret key\nRUQ${file}\ntrusted comment: timestamp:1\tfile:${file}\nAAAA\n`).toString("base64");
/** Each name and its `.sig` (the app archive's own bytes too). */
const SIGNED = (names: string[]) => Object.fromEntries(names.flatMap((n) => [[`${n}.sig`, sig(n)], ...(n.endsWith(".app.tar.gz") ? [[n, "tar"]] : [])]));

describe("in-app updates (ADR-0034)", () => {
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
  const ALL = ["Thoth_0.2.3_universal.dmg", "Thoth_0.2.3_x64-setup.exe", "Thoth_0.2.3_x64_en-US.msi", "Thoth_0.2.3_amd64.AppImage", "Thoth_0.2.3_amd64.deb"];
  const UPDATERS = ["Thoth_0.2.3_universal.app.tar.gz", "Thoth_0.2.3_x64-setup.exe", "Thoth_0.2.3_x64_en-US.msi", "Thoth_0.2.3_amd64.AppImage"];
  const full = () => folder({ ...Object.fromEntries(ALL.map((n) => [n, n])), ...SIGNED(UPDATERS) });

  it("names each platform's signed update in latest.json, with the signature's contents, by installer kind", async () => {
    const release = await collect(await full(), "2026-11-02");
    const base = "https://download.thothnotes.com/v0.2.3/";
    expect(release.platforms).toEqual({
      // The universal app, for both Mac architectures.
      "darwin-aarch64": { url: `${base}Thoth_0.2.3_universal.app.tar.gz`, signature: sig("Thoth_0.2.3_universal.app.tar.gz") },
      "darwin-x86_64": { url: `${base}Thoth_0.2.3_universal.app.tar.gz`, signature: sig("Thoth_0.2.3_universal.app.tar.gz") },
      // An NSIS install is updated by NSIS, an MSI install by the MSI (the updater looks for `{os}-{arch}-{installer}`).
      "windows-x86_64-nsis": { url: `${base}Thoth_0.2.3_x64-setup.exe`, signature: sig("Thoth_0.2.3_x64-setup.exe") },
      "windows-x86_64-msi": { url: `${base}Thoth_0.2.3_x64_en-US.msi`, signature: sig("Thoth_0.2.3_x64_en-US.msi") },
      // The AppImage updates itself; a .deb install keeps the notice (no entry for it, nor a plain `linux-x86_64`).
      "linux-x86_64-appimage": { url: `${base}Thoth_0.2.3_amd64.AppImage`, signature: sig("Thoth_0.2.3_amd64.AppImage") },
    });
    // The website and SHA256SUMS list the installers only: never a signature or the app archive.
    expect(release.files.map((f) => f.file)).toEqual([...ALL].sort());
    expect(sha256sums(release)).not.toMatch(/\.sig|\.tar\.gz/);
    // The extra files go up with the release, each immutable like the installers.
    expect(updaterUploads(release)).toEqual(["Thoth_0.2.3_amd64.AppImage.sig", "Thoth_0.2.3_universal.app.tar.gz", "Thoth_0.2.3_universal.app.tar.gz.sig", "Thoth_0.2.3_x64-setup.exe.sig", "Thoth_0.2.3_x64_en-US.msi.sig"]);
  });

  it("refuses to publish an update that is not signed, or a signature that is not one", async () => {
    for (const missing of UPDATERS) {
      const files = { ...Object.fromEntries(ALL.map((n) => [n, n])), ...SIGNED(UPDATERS) };
      delete files[`${missing}.sig`];
      await expect(collect(await folder(files), "2026-11-02"), missing).rejects.toThrow(new RegExp(`${missing.replaceAll(".", "\\.")}\\.sig is missing: the update would be unsigned`));
    }
    // The universal .dmg without its app archive: Macs could not update.
    const noArchive = { ...Object.fromEntries(ALL.map((n) => [n, n])), ...SIGNED(UPDATERS.slice(1)) };
    await expect(collect(await folder(noArchive), "2026-11-02")).rejects.toThrow(/app\.tar\.gz/);
    for (const bad of ["", "not base64 at all!", Buffer.from("just text").toString("base64")]) {
      const files = { ...Object.fromEntries(ALL.map((n) => [n, n])), ...SIGNED(UPDATERS), "Thoth_0.2.3_x64-setup.exe.sig": bad };
      await expect(collect(await folder(files), "2026-11-02"), bad).rejects.toThrow(/not a signature/);
    }
  });

  it("writes the latest.json that the 0.2.x apps' parser is tested against (crates/thoth-host/tests/fixtures)", async () => {
    const release = await collect(await full(), "2026-11-02");
    const fixture = JSON.parse(await readFile(join(import.meta.dirname, "..", "..", "crates", "thoth-host", "tests", "fixtures", "latest-0.2.3.json"), "utf8")) as unknown;
    expect(JSON.parse(JSON.stringify(release))).toEqual(fixture);
  });
});
