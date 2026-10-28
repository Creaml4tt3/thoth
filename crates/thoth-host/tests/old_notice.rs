//! In-app updates (ADR-0034) add the updater's `platforms` to the same `latest.json` the update notice reads. The apps
//! already installed (0.2.0 to 0.2.2) must still read it and still tell their people that a new version is out, so they
//! can install 0.2.3 by hand once. Their reader is copied from git history (`fixtures/notice_v0_2_2.rs`); the file is the
//! one `scripts/publish-downloads.ts` writes (`tests/release/publish-downloads.test.ts` checks it is the same).
#[path = "fixtures/notice_v0_2_2.rs"]
mod old;

const LATEST: &[u8] = include_bytes!("fixtures/latest-0.2.3.json");

#[test]
fn the_installed_0_2_x_apps_read_the_new_latest_json_and_show_the_notice() {
    let latest = old::parse_latest(LATEST).expect("the 0.2.x reader refused the new latest.json");
    assert_eq!(latest.version.to_string(), "0.2.3");
    assert_eq!(latest.date.as_deref(), Some("2026-11-02"));
    assert_eq!(latest.notes.as_deref(), Some("https://thothnotes.com/changelog/#v0-2-3"));
    for installed in ["0.2.0", "0.2.1", "0.2.2"] {
        assert!(old::is_offered(&old::Version::parse(installed).unwrap(), &latest.version), "{installed} would not be told of 0.2.3");
    }
    // The file the old apps fetch is still well under their 64 KB limit with every platform's signature in it (a real
    // signature is about 430 characters, five of them).
    assert!(LATEST.len() < 16 * 1024, "{} bytes", LATEST.len());
}

#[test]
fn the_new_reader_reads_it_the_same_way() {
    let latest = thoth_host::updates::parse_latest(LATEST).unwrap();
    assert_eq!(latest.version.to_string(), "0.2.3");
    assert_eq!(latest.notes.as_deref(), Some("https://thothnotes.com/changelog/#v0-2-3"));
}

#[test]
fn the_platforms_are_where_the_tauri_updater_looks_for_them() {
    // The updater's static format: `platforms.{key}.url` and `.signature` (tauri-plugin-updater 2.13.2, RemoteRelease).
    let value: serde_json::Value = serde_json::from_slice(LATEST).unwrap();
    let platforms = value["platforms"].as_object().unwrap();
    for key in ["darwin-aarch64", "darwin-x86_64", "windows-x86_64-nsis", "windows-x86_64-msi", "linux-x86_64-appimage"] {
        let url = platforms[key]["url"].as_str().unwrap();
        assert!(url.starts_with("https://download.thothnotes.com/v0.2.3/"), "{key}: {url}");
        assert!(!platforms[key]["signature"].as_str().unwrap().is_empty(), "{key}");
    }
    // No entry that would let a .deb install (or one whose installer is unknown) take another installer's file.
    assert!(!platforms.keys().any(|k| k.starts_with("linux-") && k != "linux-x86_64-appimage"));
    assert!(!platforms.contains_key("windows-x86_64"));
}
