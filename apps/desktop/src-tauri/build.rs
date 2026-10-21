//! Generates `allow-<command>` permissions for the contract commands so the
//! capability file can grant exactly these (and nothing else) to the webview.

/// `thoth_host::COMMANDS` with `.` replaced by `_` (checked by a unit test in src/lib.rs).
pub const TAURI_COMMANDS: &[&str] = &[
    "vault_pick", "vault_recent", "vault_open", "vault_close",
    "fs_stat", "fs_read", "fs_list", "fs_mkdirp", "fs_write", "fs_rename", "fs_remove",
    "sql_exec", "sql_run", "sql_all", "sql_get",
    "watch_start", "watch_stop",
    "source_pick", "source_open", "source_list", "source_file_open", "source_file_read", "source_file_close",
    "source_temp_create", "source_temp_write", "source_close",
];

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(TAURI_COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri build script failed");
}
