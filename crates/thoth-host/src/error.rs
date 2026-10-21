//! Host errors cross the wire as `{ code, message }` (see `HostErrorCode` in
//! `packages/platform/src/ipc.ts`). File-system codes are POSIX errno names
//! because `@thoth/local-store` checks `error.code` (e.g. `EEXIST`).
use rustix::io::Errno;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
}

pub type HostResult<T> = Result<T, HostError>;

impl HostError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn bad_argument(message: impl Into<String>) -> Self {
        Self::new("BAD_ARGUMENT", message)
    }

    pub fn bad_handle(kind: &str) -> Self {
        Self::new("BAD_HANDLE", format!("Unknown or closed {kind} handle"))
    }

    pub fn not_allowed(message: impl Into<String>) -> Self {
        Self::new("NOT_ALLOWED", message)
    }

    /// Same wording as `UnsafePathError` in `@thoth/domain`, so callers can match on the message.
    pub fn unsafe_path(path: &str, reason: &str) -> Self {
        Self::new("UNSAFE_PATH", format!("Unsafe path \"{}\": {reason}", clip(path)))
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }

    /// Maps an errno like Node does: `CODE: description, op 'path'`.
    pub fn errno(errno: Errno, op: &str, path: &str) -> Self {
        let code = errno_code(errno);
        Self::new(code, format!("{code}: {errno}, {op} '{}'", clip(path)))
    }

    pub fn io(error: &std::io::Error, op: &str, path: &str) -> Self {
        match Errno::from_io_error(error) {
            Some(errno) => Self::errno(errno, op, path),
            None => Self::new("EIO", format!("EIO: {error}, {op} '{}'", clip(path))),
        }
    }
}

/// Errno names the contract knows; anything else is reported as `EIO`.
pub fn errno_code(errno: Errno) -> &'static str {
    match errno {
        Errno::EXIST => "EEXIST",
        Errno::NOENT => "ENOENT",
        Errno::NOTDIR => "ENOTDIR",
        Errno::ISDIR => "EISDIR",
        Errno::NOTEMPTY => "ENOTEMPTY",
        Errno::ACCESS => "EACCES",
        Errno::LOOP => "ELOOP",
        Errno::PERM => "EPERM",
        Errno::NOSPC => "ENOSPC",
        Errno::ROFS => "EROFS",
        Errno::NAMETOOLONG => "ENAMETOOLONG",
        _ => "EIO",
    }
}

/// Keeps error messages bounded when a caller sends a huge path.
fn clip(s: &str) -> String {
    if s.len() <= 300 {
        return s.to_owned();
    }
    let mut end = 300;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}
