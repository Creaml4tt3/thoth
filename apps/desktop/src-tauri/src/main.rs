// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows and Linux: Open With passes the Markdown files to open as arguments (ADR-0057). macOS sends them as an
    // event instead, and may add its own arguments, so none are taken there.
    let files = if cfg!(target_os = "macos") { Vec::new() } else { std::env::args_os().skip(1).map(std::path::PathBuf::from).collect() };
    thoth_desktop_lib::run(files);
}
