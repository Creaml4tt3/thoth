//! Modules (ADR-0055, plan §5): large local features downloaded on demand. OCR is the first and only one.
//!
//! - `catalog`: what can be installed. The program files come from `runtime.json`, compiled into the app (code changes
//!   only with an app update); the models from the signed model list, with a compiled-in copy as the fallback.
//! - `store`: downloads, checks and switches the files under `<app-data>/modules/ocr/`.
pub mod catalog;
pub mod store;

/// This build's target, as `runtime.json` and the model list name it.
pub const TARGET: &str = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "aarch64-apple-darwin"
} else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
    "x86_64-apple-darwin"
} else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
    "x86_64-pc-windows-msvc"
} else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
    "x86_64-unknown-linux-gnu"
} else {
    "unsupported"
};
