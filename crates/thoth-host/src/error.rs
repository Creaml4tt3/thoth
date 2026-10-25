//! Host errors cross the wire as `{ code, message }` (see `HostErrorCode` in
//! `packages/platform/src/ipc.ts`). File-system codes are POSIX errno names
//! because `@thoth/local-store` checks `error.code` (e.g. `EEXIST`). On Windows
//! the Win32 error codes are mapped to the same names (`win32_code`).
#[cfg(unix)]
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
    #[cfg(unix)]
    pub fn errno(errno: Errno, op: &str, path: &str) -> Self {
        let code = errno_code(errno);
        Self::new(code, format!("{code}: {errno}, {op} '{}'", clip(path)))
    }

    /// Maps a Win32 error code (`GetLastError`, or an NTSTATUS through `RtlNtStatusToDosError`) the same way.
    #[cfg(windows)]
    pub fn win32(error: u32, op: &str, path: &str) -> Self {
        let code = win32_code(error);
        let description = std::io::Error::from_raw_os_error(error as i32);
        Self::new(code, format!("{code}: {description}, {op} '{}'", clip(path)))
    }

    pub fn io(error: &std::io::Error, op: &str, path: &str) -> Self {
        #[cfg(unix)]
        let mapped = Errno::from_io_error(error).map(|errno| Self::errno(errno, op, path));
        #[cfg(windows)]
        let mapped = error.raw_os_error().map(|code| Self::win32(code as u32, op, path));
        #[cfg(not(any(unix, windows)))]
        let mapped: Option<Self> = None;
        mapped.unwrap_or_else(|| Self::new("EIO", format!("EIO: {error}, {op} '{}'", clip(path))))
    }
}

/// Errno names the contract knows; anything else is reported as `EIO`.
#[cfg(unix)]
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

/// The same names for Win32 error codes, following libuv's mapping (what Node reports on Windows) where the
/// contract has the name; anything else is `EIO`.
#[cfg(windows)]
pub fn win32_code(error: u32) -> &'static str {
    use windows_sys::Win32::Foundation as f;
    match error {
        f::ERROR_FILE_EXISTS | f::ERROR_ALREADY_EXISTS => "EEXIST",
        f::ERROR_FILE_NOT_FOUND | f::ERROR_PATH_NOT_FOUND | f::ERROR_INVALID_NAME | f::ERROR_BAD_NETPATH | f::ERROR_BAD_PATHNAME | f::ERROR_INVALID_DRIVE => "ENOENT",
        f::ERROR_DIRECTORY => "ENOTDIR",
        // What the Windows layer reports for STATUS_FILE_IS_A_DIRECTORY (see win::nt).
        f::ERROR_DIRECTORY_NOT_SUPPORTED => "EISDIR",
        f::ERROR_DIR_NOT_EMPTY => "ENOTEMPTY",
        f::ERROR_ACCESS_DENIED | f::ERROR_PRIVILEGE_NOT_HELD => "EPERM",
        f::ERROR_CANT_RESOLVE_FILENAME | f::ERROR_STOPPED_ON_SYMLINK => "ELOOP",
        f::ERROR_DISK_FULL | f::ERROR_HANDLE_DISK_FULL => "ENOSPC",
        f::ERROR_WRITE_PROTECT => "EROFS",
        f::ERROR_FILENAME_EXCED_RANGE => "ENAMETOOLONG",
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
