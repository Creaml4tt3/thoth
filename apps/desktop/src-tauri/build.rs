//! Generates `allow-<command>` permissions for the contract commands so the
//! capability file can grant exactly these (and nothing else) to the webview.

/// `thoth_host::COMMANDS` with `.` replaced by `_` (checked by a unit test in src/lib.rs).
pub const TAURI_COMMANDS: &[&str] = &[
    "vault_pick", "vault_recent", "vault_open", "vault_close", "vault_reveal",
    "fs_stat", "fs_read", "fs_list", "fs_mkdirp", "fs_write", "fs_rename", "fs_remove",
    "sql_exec", "sql_run", "sql_all", "sql_get",
    "watch_start", "watch_stop",
    "source_pick", "source_open", "source_list", "source_file_open", "source_file_read", "source_file_close",
    "source_temp_create", "source_temp_write", "source_close",
    "server_list", "server_add", "server_remove", "server_signIn", "server_signInCancel", "server_useToken", "server_signOut",
    "api_call",
    "agent_detect", "agent_run_create", "agent_fs_stat", "agent_fs_read", "agent_fs_list", "agent_fs_mkdirp", "agent_fs_write",
    "agent_start", "agent_events", "agent_cancel", "agent_run_dispose", "agent_sweep",
    "agent_history_write", "agent_history_read", "agent_history_list", "agent_history_delete",
];

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(TAURI_COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri build script failed");
}
