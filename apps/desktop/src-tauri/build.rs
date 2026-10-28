//! Generates `allow-<command>` permissions for the contract commands so the
//! capability file can grant exactly these (and nothing else) to the webview.

/// `thoth_host::COMMANDS` with `.` replaced by `_`, then the shell's own commands (both checked by unit tests in src/lib.rs).
pub const TAURI_COMMANDS: &[&str] = &[
    "vault_pick", "vault_recent", "vault_open", "vault_close", "vault_reveal", "vault_shared",
    "fs_stat", "fs_read", "fs_list", "fs_mkdirp", "fs_write", "fs_rename", "fs_remove",
    "sql_exec", "sql_run", "sql_all", "sql_get",
    "watch_start", "watch_stop",
    "source_pick", "source_open", "source_list", "source_file_open", "source_file_read", "source_file_close",
    "source_temp_create", "source_temp_write", "source_close",
    "image_pick", "image_read",
    "server_list", "server_add", "server_remove", "server_signIn", "server_signInCancel", "server_useToken", "server_signOut",
    "api_call",
    "agent_detect", "agent_run_create", "agent_fs_stat", "agent_fs_read", "agent_fs_list", "agent_fs_mkdirp", "agent_fs_write",
    "agent_start", "agent_events", "agent_cancel", "agent_run_dispose", "agent_sweep",
    "agent_history_write", "agent_history_read", "agent_history_list", "agent_history_delete",
    // Link previews (ADR-0020): the host fetches and opens web links; the webview has no http or opener plugin.
    "link_preview", "link_preview_clear", "link_open",
    // The update notice (ADR-0022): the host asks `latest.json`; the webview gets a verdict and no network.
    "update_check", "update_settings",
    // In-app updates (ADR-0034): the host downloads, checks and installs through the updater plugin's Rust API; the
    // webview gets these four commands and progress events, and no plugin permission.
    "update_install", "update_cancel", "update_status", "update_restart",
    // Connected apps (ADR-0021): the settings, the Allow or Deny, a window's answer and the log; thoth-mcp's socket is
    // the host's own.
    "mcp_settings", "mcp_configure", "mcp_decide", "mcp_forget", "mcp_answer", "mcp_log",
    // The shell's own commands (src/lib.rs `SHELL_COMMANDS`): Thoth's windows on a Private Space (ADR-0019).
    "window_open", "window_close",
];

/// An address from the environment, for the app's build (ADR-0022): `https`, or empty (no update notice); never a
/// line break, which could add a build directive. A debug build may read `latest.json` from `http://127.0.0.1:…`, for a
/// local test of in-app updates (ADR-0034); a release build never.
fn address(name: &str) {
    println!("cargo:rerun-if-env-changed={name}");
    let Ok(value) = std::env::var(name) else { return };
    let debug = std::env::var("PROFILE").as_deref() == Ok("debug");
    let local = debug && name == "THOTH_UPDATE_URL" && value.starts_with("http://127.0.0.1:");
    assert!(value.is_empty() || ((value.starts_with("https://") || local) && !value.chars().any(|c| c.is_control() || c.is_whitespace())), "{name} must be empty or an https address");
    println!("cargo:rustc-env={name}={value}");
}

fn main() {
    // A self-built copy may read `latest.json` from its own address (or none: empty) and send "Download" to its own page.
    address("THOTH_UPDATE_URL");
    address("THOTH_DOWNLOADS_PAGE_URL");
    let manifest = tauri_build::AppManifest::new().commands(TAURI_COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri build script failed");
}
