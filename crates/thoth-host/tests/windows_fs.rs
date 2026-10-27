//! The Windows file layer through the host commands (`fs.*`, `vault.open`, `source.*`): reparse points (a junction
//! made here, and symlinks when the account may create them), Windows names, case and normalization clashes,
//! no-replace and replacing renames, the CAS write's atomic replace, read-only files and long paths.
//! tests/ports runs the shared port contract against the same host.
#![cfg(windows)]

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thoth_host::{Browser, FileManager, Host, HostConfig, HostResult, MemorySecretStore, Picker};

struct NoPicker;
impl Picker for NoPicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        None
    }
    fn pick_source(&self, _: bool) -> Option<PathBuf> {
        None
    }
}
struct NoBrowser;
impl Browser for NoBrowser {
    fn open(&self, _: &str) -> HostResult<()> {
        Ok(())
    }
}
struct NoFiles;
impl FileManager for NoFiles {
    fn reveal(&self, _: &Path, _: Option<&Path>) -> HostResult<()> {
        Ok(())
    }
}

struct Fixture {
    host: Host,
    vault: String,
    root: PathBuf,
    outside: PathBuf,
    _base: tempfile::TempDir,
    _data: tempfile::TempDir,
}

fn canonical(path: &Path) -> PathBuf {
    thoth_host::paths::canonicalize_path(path).unwrap()
}

fn host(base: &Path, data: &Path, disable_hardlink: bool) -> Host {
    Host::new(HostConfig {
        data_dir: Some(data.to_owned()),
        allow_roots: vec![base.to_owned()],
        picker: Arc::new(NoPicker),
        events: Arc::new(|_, _| {}),
        disable_hardlink,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(NoBrowser),
        file_manager: Arc::new(NoFiles),
        agent_search_dirs: Some(Vec::new()),
        link_preview_loopback: false,
    })
}

fn fixture() -> Fixture {
    let base = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let root = canonical(base.path()).join("Vault");
    let outside = canonical(base.path()).join("Outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.md"), "secret").unwrap();
    let host = host(base.path(), data.path(), false);
    let opened = host.call("vault.open", &json!({ "root": root.to_string_lossy() }), None).unwrap().0;
    let vault = opened["vault"].as_str().unwrap().to_owned();
    Fixture { host, vault, root, outside, _base: base, _data: data }
}

impl Fixture {
    fn call(&self, command: &str, mut args: Value) -> HostResult<Value> {
        args["vault"] = json!(self.vault);
        self.host.call(command, &args, None).map(|r| r.0)
    }
    fn write(&self, path: &str, data: &[u8], exclusive: bool) -> HostResult<()> {
        self.host.call("fs.write", &json!({ "vault": self.vault, "path": path, "exclusive": exclusive }), Some(data)).map(|_| ())
    }
    fn read(&self, path: &str) -> HostResult<Vec<u8>> {
        self.host.call("fs.read", &json!({ "vault": self.vault, "path": path }), None).map(|r| r.1.unwrap())
    }
    fn stat(&self, path: &str) -> Value {
        self.call("fs.stat", json!({ "path": path })).unwrap()
    }
    fn rename(&self, from: &str, to: &str, no_replace: bool) -> HostResult<()> {
        self.call("fs.rename", json!({ "from": from, "to": to, "noReplace": no_replace })).map(|_| ())
    }
    fn names(&self, dir: &str) -> Vec<(String, String)> {
        let listed = self.call("fs.list", json!({ "dir": dir })).unwrap();
        let mut names: Vec<(String, String)> = listed.as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap().to_owned(), e["kind"].as_str().unwrap().to_owned())).filter(|(n, _)| n != ".thoth").collect();
        names.sort();
        names
    }
}

fn code<T: std::fmt::Debug>(result: HostResult<T>) -> &'static str {
    result.unwrap_err().code
}

/// A directory junction (no privilege needed), made with `mklink /J` as a user would.
fn junction(link: &Path, target: &Path) {
    // cmd reads a `/` inside a path as a switch.
    let backslashes = |p: &Path| p.to_string_lossy().replace('/', "\\");
    let out = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(backslashes(link)).arg(backslashes(target)).output().unwrap();
    assert!(out.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&out.stderr));
    let meta = std::fs::symlink_metadata(link).unwrap();
    use std::os::windows::fs::MetadataExt;
    assert_ne!(meta.file_attributes() & 0x400, 0, "not a reparse point");
}

/// Symlinks need Developer Mode or an elevated account (GitHub's runners are elevated); false if not allowed here.
fn try_symlinks(f: &Fixture) -> bool {
    let file = std::os::windows::fs::symlink_file(f.outside.join("secret.md"), f.root.join("file-link.md"));
    let dir = std::os::windows::fs::symlink_dir(&f.outside, f.root.join("dir-link"));
    match (file, dir) {
        (Ok(()), Ok(())) => true,
        (a, b) => {
            eprintln!("skipping symlink checks: {a:?} {b:?}");
            false
        }
    }
}

#[test]
fn a_junction_is_never_followed_in_any_component() {
    let f = fixture();
    junction(&f.root.join("j"), &f.outside);
    assert_eq!(f.stat("j")["kind"], json!("symlink"));
    assert!(f.names("").contains(&("j".to_owned(), "symlink".to_owned())));
    assert_eq!(code(f.read("j/secret.md")), "UNSAFE_PATH");
    assert_eq!(code(f.write("j/new.md", b"x", false)), "UNSAFE_PATH");
    assert_eq!(code(f.write("j/new.md", b"x", true)), "UNSAFE_PATH");
    assert_eq!(code(f.call("fs.list", json!({ "dir": "j" }))), "UNSAFE_PATH");
    assert_eq!(code(f.call("fs.mkdirp", json!({ "dir": "j/sub" }))), "UNSAFE_PATH");
    assert_eq!(code(f.call("fs.stat", json!({ "path": "j/secret.md" }))), "UNSAFE_PATH");
    assert_eq!(code(f.rename("j/secret.md", "stolen.md", false)), "UNSAFE_PATH");
    f.write("mine.md", b"m", true).unwrap();
    assert_eq!(code(f.rename("mine.md", "j/mine.md", true)), "UNSAFE_PATH");
    assert_eq!(code(f.call("fs.remove", json!({ "path": "j/secret.md" }))), "UNSAFE_PATH");
    // The final component: a junction is not a file to read, and writing over it is refused.
    assert!(f.read("j").is_err());
    assert!(f.write("j", b"pwned", false).is_err());
    // Removing it removes the junction only; a tree holding one is removed without entering it.
    std::fs::create_dir_all(f.root.join("tree/inner")).unwrap();
    junction(&f.root.join("tree/inner/out"), &f.outside);
    f.call("fs.remove", json!({ "path": "tree" })).unwrap();
    f.call("fs.remove", json!({ "path": "j" })).unwrap();
    assert_eq!(f.stat("j"), Value::Null);
    assert_eq!(f.stat("tree"), Value::Null);
    let left: Vec<_> = std::fs::read_dir(&f.outside).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(left, vec![std::ffi::OsString::from("secret.md")]);
    assert_eq!(std::fs::read_to_string(f.outside.join("secret.md")).unwrap(), "secret");
}

#[test]
fn symlinks_are_reported_and_refused() {
    let f = fixture();
    if !try_symlinks(&f) {
        return;
    }
    assert_eq!(f.stat("file-link.md")["kind"], json!("symlink"));
    assert_eq!(f.stat("dir-link")["kind"], json!("symlink"));
    assert_eq!(code(f.read("file-link.md")), "ELOOP");
    assert_eq!(code(f.write("file-link.md", b"pwned", false)), "ELOOP");
    assert_eq!(code(f.write("file-link.md", b"pwned", true)), "EEXIST");
    assert_eq!(code(f.read("dir-link/secret.md")), "UNSAFE_PATH");
    assert_eq!(code(f.call("fs.mkdirp", json!({ "dir": "file-link.md/x" }))), "UNSAFE_PATH");
    f.call("fs.remove", json!({ "path": "file-link.md" })).unwrap();
    f.call("fs.remove", json!({ "path": "dir-link" })).unwrap();
    assert_eq!(std::fs::read_to_string(f.outside.join("secret.md")).unwrap(), "secret");
}

#[test]
fn a_vault_whose_metadata_or_index_is_a_link_does_not_open() {
    let base = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let b = canonical(base.path());
    let host = host(base.path(), data.path(), false);
    std::fs::create_dir_all(b.join("v1")).unwrap();
    std::fs::create_dir_all(b.join("elsewhere")).unwrap();
    junction(&b.join("v1/.thoth"), &b.join("elsewhere"));
    assert_eq!(code(host.call("vault.open", &json!({ "root": b.join("v1").to_string_lossy() }), None)), "UNSAFE_PATH");
    assert!(!b.join("elsewhere/index.sqlite").exists());
    std::fs::create_dir_all(b.join("v2/.thoth")).unwrap();
    std::fs::write(b.join("elsewhere.sqlite"), "").unwrap();
    if std::os::windows::fs::symlink_file(b.join("elsewhere.sqlite"), b.join("v2/.thoth/index.sqlite")).is_ok() {
        assert_eq!(code(host.call("vault.open", &json!({ "root": b.join("v2").to_string_lossy() }), None)), "SQLITE_ERROR");
    }
    // A root reached through a junction opens as its canonical target, which is what the host shows and keeps.
    std::fs::create_dir_all(b.join("real")).unwrap();
    junction(&b.join("alias"), &b.join("real"));
    let opened = host.call("vault.open", &json!({ "root": b.join("alias").to_string_lossy() }), None).unwrap().0;
    assert_eq!(opened["root"], json!(b.join("real").to_string_lossy()));
}

#[test]
fn names_windows_cannot_hold_are_refused_or_absent() {
    let f = fixture();
    for bad in ["CON", "nul.md", "Com1.txt", "LPT9", "a.md:stream", "x.", "x ", "what?.md", "a<b.md", "a|b.md", "dir./x.md", "aux/x.md"] {
        assert_eq!(code(f.write(bad, b"x", false)), "UNSAFE_PATH", "{bad}");
        assert_eq!(code(f.write(bad, b"x", true)), "UNSAFE_PATH", "{bad}");
        assert_eq!(code(f.call("fs.mkdirp", json!({ "dir": bad }))), "UNSAFE_PATH", "{bad}");
        assert_eq!(f.stat(bad), Value::Null, "{bad}");
        assert_eq!(code(f.read(bad)), "ENOENT", "{bad}");
        f.call("fs.remove", json!({ "path": bad })).unwrap();
    }
    f.write("ok.md", b"x", true).unwrap();
    assert_eq!(code(f.rename("ok.md", "ok.md:hidden", false)), "UNSAFE_PATH");
    assert_eq!(code(f.rename("ok.md", "PRN.md", true)), "UNSAFE_PATH");
    assert_eq!(f.names(""), vec![("ok.md".to_owned(), "file".to_owned())]);
}

#[test]
fn names_clash_case_insensitively_and_across_normalization_forms() {
    let f = fixture();
    f.write("Note.md", b"one", true).unwrap();
    assert_eq!(code(f.write("note.md", b"two", true)), "EEXIST");
    assert_eq!(code(f.write("NOTE.MD", b"two", true)), "EEXIST");
    assert_eq!(f.read("nOtE.md").unwrap(), b"one");
    f.write("a.tmp", b"a", true).unwrap();
    assert_eq!(code(f.rename("a.tmp", "NOTE.md", true)), "EEXIST");
    // A rename that only changes letter case: refused with noReplace (as link() on a case-insensitive volume),
    // done without it (what Vault.move uses for a case-only rename).
    assert_eq!(code(f.rename("Note.md", "NOTE.md", true)), "EEXIST");
    f.rename("Note.md", "NOTE.md", false).unwrap();
    assert_eq!(f.names(""), vec![("NOTE.md".to_owned(), "file".to_owned()), ("a.tmp".to_owned(), "file".to_owned())]);
    f.call("fs.mkdirp", json!({ "dir": "Dir/Sub" })).unwrap();
    f.call("fs.mkdirp", json!({ "dir": "dir/sub/deeper" })).unwrap();
    assert_eq!(f.names("DIR"), vec![("Sub".to_owned(), "directory".to_owned())]);
    // A name stored decomposed (NFD, as macOS tools write it) is found by its NFC spelling and listed in NFC.
    let nfd = "Cafe\u{301}.md";
    std::fs::write(f.root.join(nfd), "crème").unwrap();
    assert!(f.names("").contains(&("Caf\u{e9}.md".to_owned(), "file".to_owned())));
    assert_eq!(f.read("Caf\u{e9}.md").unwrap(), "crème".as_bytes());
    assert_eq!(code(f.write("Caf\u{e9}.md", b"twin", true)), "EEXIST");
    f.write("Caf\u{e9}.md", b"edited", false).unwrap();
    assert_eq!(std::fs::read(f.root.join(nfd)).unwrap(), b"edited");
    assert_eq!(std::fs::read_dir(&f.root).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("Caf")).count(), 1);
}

#[test]
fn renames_replace_atomically_or_refuse_to_replace() {
    let f = fixture();
    f.write("target.md", b"old", true).unwrap();
    f.write("temp.md", b"new", true).unwrap();
    assert_eq!(code(f.rename("temp.md", "target.md", true)), "EEXIST");
    assert_eq!(f.read("target.md").unwrap(), b"old");
    assert_eq!(f.read("temp.md").unwrap(), b"new");
    // The CAS write's replace works while another program has the target open (sharing delete, as editors and
    // std do) and when the target is read-only, as rename(2) does.
    let open_elsewhere = std::fs::File::open(f.root.join("target.md")).unwrap();
    f.rename("temp.md", "target.md", false).unwrap();
    drop(open_elsewhere);
    assert_eq!(f.read("target.md").unwrap(), b"new");
    assert_eq!(f.stat("temp.md"), Value::Null);
    f.write("temp2.md", b"newer", true).unwrap();
    let mut perms = std::fs::metadata(f.root.join("target.md")).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(f.root.join("target.md"), perms).unwrap();
    f.rename("temp2.md", "target.md", false).unwrap();
    assert_eq!(f.read("target.md").unwrap(), b"newer");
    // No-replace into a free name moves the file; a missing source is ENOENT; folders move too.
    f.call("fs.mkdirp", json!({ "dir": "d" })).unwrap();
    f.rename("target.md", "d/moved.md", true).unwrap();
    assert_eq!(f.stat("target.md"), Value::Null);
    assert_eq!(f.read("d/moved.md").unwrap(), b"newer");
    assert_eq!(code(f.rename("missing.md", "x.md", false)), "ENOENT");
    f.rename("d", "e", false).unwrap();
    assert_eq!(f.read("e/moved.md").unwrap(), b"newer");
    // Read-only files are removed too, as unlink(2) does.
    let mut perms = std::fs::metadata(f.root.join("e/moved.md")).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(f.root.join("e/moved.md"), perms).unwrap();
    f.call("fs.remove", json!({ "path": "e" })).unwrap();
    assert_eq!(f.stat("e"), Value::Null);
}

#[test]
fn the_exclusive_copy_fallback_never_replaces() {
    let base = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let root = canonical(base.path()).join("v");
    std::fs::create_dir(&root).unwrap();
    let host = host(base.path(), data.path(), true);
    let vault = host.call("vault.open", &json!({ "root": root.to_string_lossy() }), None).unwrap().0["vault"].as_str().unwrap().to_owned();
    let write = |p: &str, d: &[u8]| host.call("fs.write", &json!({ "vault": vault, "path": p }), Some(d)).unwrap();
    let rename = |a: &str, b: &str| host.call("fs.rename", &json!({ "vault": vault, "from": a, "to": b, "noReplace": true }), None);
    write("a.tmp", b"A");
    rename("a.tmp", "moved.md").unwrap();
    assert!(!root.join("a.tmp").exists());
    write("b.tmp", b"B");
    assert_eq!(rename("b.tmp", "moved.md").unwrap_err().code, "EEXIST");
    assert_eq!(std::fs::read(root.join("moved.md")).unwrap(), b"A");
    assert_eq!(std::fs::read(root.join("b.tmp")).unwrap(), b"B");
}

#[test]
fn long_paths_work_past_max_path() {
    let f = fixture();
    let segment = "a-fairly-long-folder-name-for-max-path-xx";
    let dir = [segment; 8].join("/");
    let file = format!("{dir}/note with a long name, past MAX_PATH.md");
    assert!(f.root.join(&file).as_os_str().len() > 300);
    f.call("fs.mkdirp", json!({ "dir": dir })).unwrap();
    f.write(&file, b"deep", true).unwrap();
    f.write(&file, b"deeper", false).unwrap();
    assert_eq!(f.read(&file).unwrap(), b"deeper");
    assert_eq!(f.stat(&file)["size"], json!(6));
    assert_eq!(f.names(&dir), vec![("note with a long name, past MAX_PATH.md".to_owned(), "file".to_owned())]);
    let moved = format!("{dir}/renamed.md");
    f.rename(&file, &moved, true).unwrap();
    // std adds the \\?\ prefix to long paths itself.
    assert_eq!(std::fs::read(f.root.join(&moved)).unwrap(), b"deeper");
    f.call("fs.remove", json!({ "path": segment })).unwrap();
    assert_eq!(f.stat(segment), Value::Null);
}

#[test]
fn stat_matches_what_node_reports() {
    let f = fixture();
    f.write("f.md", b"12345", true).unwrap();
    let st = f.stat("f.md");
    assert_eq!((st["kind"].as_str(), st["size"].as_u64()), (Some("file"), Some(5)));
    let modified = std::fs::metadata(f.root.join("f.md")).unwrap().modified().unwrap();
    let ms = modified.duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as f64 / 1e6;
    assert!((st["mtimeMs"].as_f64().unwrap() - ms).abs() < 0.001);
    assert_eq!(f.stat("")["kind"], json!("directory"));
    assert_eq!(f.stat("f.md/child"), Value::Null);
    assert_eq!(f.stat("missing/deeper.md"), Value::Null);
    f.call("fs.mkdirp", json!({ "dir": "x" })).unwrap();
    assert_eq!(code(f.call("fs.mkdirp", json!({ "dir": "f.md" }))), "EEXIST");
    assert_eq!(code(f.call("fs.mkdirp", json!({ "dir": "f.md/sub" }))), "ENOTDIR");
    assert_eq!(code(f.read("x")), "EISDIR");
}

#[test]
fn a_folder_source_never_follows_a_junction_or_names_a_stream() {
    let base = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let b = canonical(base.path());
    std::fs::create_dir_all(b.join("Export/sub")).unwrap();
    std::fs::create_dir_all(b.join("outside")).unwrap();
    std::fs::write(b.join("Export/a.md"), "0123456789").unwrap();
    std::fs::write(b.join("outside/secret.md"), "secret").unwrap();
    junction(&b.join("Export/linkdir"), &b.join("outside"));
    let host = host(base.path(), data.path(), false);
    let source = host.call("source.open", &json!({ "location": b.join("Export").to_string_lossy() }), None).unwrap().0["source"].as_str().unwrap().to_owned();
    let listed = host.call("source.list", &json!({ "source": source, "dir": "" }), None).unwrap().0;
    let mut kinds: Vec<(String, String, u64)> = listed.as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap().into(), e["kind"].as_str().unwrap().into(), e["size"].as_u64().unwrap())).collect();
    kinds.sort();
    assert_eq!(kinds, vec![("a.md".into(), "file".into(), 10), ("linkdir".into(), "symlink".into(), 0), ("sub".into(), "directory".into(), 0)]);
    let open = |path: &str| host.call("source.file.open", &json!({ "source": source, "path": path }), None);
    assert_eq!(open("linkdir/secret.md").unwrap_err().code, "UNSAFE_PATH");
    assert!(host.call("source.list", &json!({ "source": source, "dir": "linkdir" }), None).is_err());
    assert_eq!(open("a.md:stream").unwrap_err().code, "ENOENT");
    assert_eq!(open("sub").unwrap_err().code, "NOT_A_REGULAR_FILE");
    let file = open("a.md").unwrap().0;
    assert_eq!(file["size"], json!(10));
    let read = host.call("source.file.read", &json!({ "file": file["file"], "position": 8, "length": 100 }), None).unwrap().1.unwrap();
    assert_eq!(read, b"89");
    let past = host.call("source.file.read", &json!({ "file": file["file"], "position": 50, "length": 10 }), None).unwrap().1.unwrap();
    assert!(past.is_empty());
    // Temp files: written, read back, and gone when closed.
    let temp = host.call("source.temp.create", &json!({ "source": source }), None).unwrap().0["file"].clone();
    host.call("source.temp.write", &json!({ "file": temp, "position": 0 }), Some(b"hello")).unwrap();
    assert_eq!(host.call("source.file.read", &json!({ "file": temp, "position": 0, "length": 5 }), None).unwrap().1.unwrap(), b"hello");
    host.call("source.close", &json!({ "source": source }), None).unwrap();
    // A root that is itself a junction is opened as its target (canonicalized), never as the link.
    let archive = b.join("export.zip");
    std::fs::write(&archive, "PK").unwrap();
    let zip = host.call("source.open", &json!({ "location": archive.to_string_lossy() }), None).unwrap().0;
    assert_eq!(zip["rootKind"], json!("file"));
}

/// A small exFAT volume in a virtual disk, at a free drive letter as a USB drive would be (diskpart needs an
/// administrator, which CI runners are). None where it cannot be made, except in CI, where that is a failure.
struct ExFat {
    vdisk: PathBuf,
    mount: PathBuf,
    _dir: tempfile::TempDir,
}

impl ExFat {
    fn make() -> Option<Self> {
        let dir = tempfile::tempdir().unwrap();
        let vdisk = canonical(dir.path()).join("exfat.vhdx");
        let skip = |why: &str| {
            assert!(std::env::var_os("CI").is_none(), "could not make an exFAT volume in CI: {why}");
            eprintln!("skipped: no exFAT volume (diskpart needs an administrator): {why}");
        };
        let Some(letter) = ('M'..='Y').rev().find(|l| !Path::new(&format!("{l}:\\")).exists()) else {
            skip("no free drive letter");
            return None;
        };
        let script = format!(
            "create vdisk file=\"{0}\" maximum=64 type=expandable\nselect vdisk file=\"{0}\"\nattach vdisk\ncreate partition primary\nformat fs=exfat quick label=THOTHX\nassign letter={letter}\n",
            vdisk.display()
        );
        let script_file = dir.path().join("make.txt");
        std::fs::write(&script_file, script).unwrap();
        let out = std::process::Command::new("diskpart").arg("/s").arg(&script_file).output().unwrap();
        let mount = PathBuf::from(format!("{letter}:\\"));
        let made = Self { vdisk, mount, _dir: dir };
        if !out.status.success() || std::fs::read_dir(&made.mount).is_err() {
            skip(&String::from_utf8_lossy(&out.stdout));
            return None;
        }
        Some(made)
    }
}

impl Drop for ExFat {
    fn drop(&mut self) {
        let script = format!("select vdisk file=\"{}\"\ndetach vdisk\n", self.vdisk.display());
        let file = self.vdisk.with_extension("detach.txt");
        let _ = std::fs::write(&file, script);
        let _ = std::process::Command::new("diskpart").arg("/s").arg(&file).output();
    }
}

/// FAT32 and exFAT drives (USB sticks, SD cards, external drives) answer the attribute-tag query with "The parameter
/// is incorrect" (os error 87): an Obsidian vault on one must still import, and open as a Private Space.
#[test]
fn an_exfat_drive_imports_and_opens() {
    let Some(volume) = ExFat::make() else { return };
    // A folder with a space in its name, as in the report (E:\\01 Work WISS\\Popnaja).
    let root = canonical(&volume.mount).join("01 Work");
    std::fs::create_dir_all(root.join("Popnaja/.obsidian")).unwrap();
    std::fs::create_dir_all(root.join("Popnaja/Notes")).unwrap();
    std::fs::write(root.join("Popnaja/Notes/a.md"), "# A\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let host = host(&root, data.path(), false);

    // The folder import (the reported error: fstat on the source's root).
    let source = host.call("source.open", &json!({ "location": root.join("Popnaja").to_string_lossy() }), None).unwrap().0;
    assert_eq!(source["rootKind"], json!("directory"));
    let id = source["source"].as_str().unwrap().to_owned();
    let listed = host.call("source.list", &json!({ "source": id, "dir": "Notes" }), None).unwrap().0;
    assert_eq!(listed[0]["name"], json!("a.md"));
    let file = host.call("source.file.open", &json!({ "source": id, "path": "Notes/a.md" }), None).unwrap().0;
    assert_eq!(file["size"], json!(4));
    host.call("source.close", &json!({ "source": id }), None).unwrap();

    // The same folder as a Private Space: stat, write, rename and remove.
    std::fs::create_dir(root.join("Vault")).unwrap();
    let vault = host.call("vault.open", &json!({ "root": root.join("Vault").to_string_lossy() }), None).unwrap().0["vault"].as_str().unwrap().to_owned();
    let call = |c: &str, a: Value| {
        let mut a = a;
        a["vault"] = json!(vault);
        host.call(c, &a, None).map(|r| r.0)
    };
    host.call("fs.write", &json!({ "vault": vault, "path": "n.md", "exclusive": true }), Some(b"one")).unwrap();
    host.call("fs.write", &json!({ "vault": vault, "path": "n.md" }), Some(b"two")).unwrap();
    assert_eq!(call("fs.stat", json!({ "path": "n.md" })).unwrap()["kind"], json!("file"));
    assert_eq!(call("fs.stat", json!({ "path": "" })).unwrap()["kind"], json!("directory"));
    call("fs.mkdirp", json!({ "dir": "sub" })).unwrap();
    call("fs.rename", json!({ "from": "n.md", "to": "sub/m.md", "noReplace": true })).unwrap();
    assert_eq!(std::fs::read(root.join("Vault/sub/m.md")).unwrap(), b"two");
    call("fs.remove", json!({ "path": "sub" })).unwrap();
    assert_eq!(call("fs.stat", json!({ "path": "sub" })).unwrap(), Value::Null);
}
