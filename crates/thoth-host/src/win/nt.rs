//! NT file primitives on handles. `open_at` is the `openat` of this layer: `NtCreateFile` with
//! `OBJECT_ATTRIBUTES.RootDirectory` = an open directory handle and a single-component name, always with
//! `FILE_OPEN_REPARSE_POINT` so a reparse point (symlink, junction, mount point, ...) is opened as itself and never
//! followed. Names are matched case-insensitively (`OBJ_CASE_INSENSITIVE`, what Win32 `CreateFileW` does), so a
//! directory with per-directory case sensitivity enabled stays case-sensitive, as the volume decides.
//!
//! Every handle shares read, write and delete, so the host never blocks other programs (or the user renaming a
//! folder in Explorer) while it works; the relative walk keeps working on a renamed directory, as an fd does.
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem as ntfs;
use windows_sys::Win32::Foundation::{self as f, HANDLE, NTSTATUS, UNICODE_STRING};
use windows_sys::Win32::Storage::FileSystem as fs;
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::WindowsProgramming::{FILE_RENAME_FLAG_POSIX_SEMANTICS, FILE_RENAME_FLAG_REPLACE_IF_EXISTS};

/// A Win32 error code: from `GetLastError`, or an NTSTATUS mapped by `status_error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OsError(pub u32);

impl OsError {
    pub fn last() -> Self {
        Self(unsafe { f::GetLastError() })
    }

    pub fn is_not_found(self) -> bool {
        matches!(self.0, f::ERROR_FILE_NOT_FOUND | f::ERROR_PATH_NOT_FOUND)
    }
}

/// Lists a directory's entries, opens a child relative to it, and reads its attributes.
pub const DIR_ACCESS: u32 = fs::FILE_LIST_DIRECTORY | fs::FILE_TRAVERSE | fs::FILE_READ_ATTRIBUTES;
pub const READ_ACCESS: u32 = fs::FILE_GENERIC_READ;
pub const WRITE_ACCESS: u32 = fs::FILE_GENERIC_WRITE | fs::FILE_READ_ATTRIBUTES;
pub const DELETE_ACCESS: u32 = fs::DELETE | fs::FILE_READ_ATTRIBUTES;
pub const ATTR_ACCESS: u32 = fs::FILE_READ_ATTRIBUTES;
const SHARE_ALL: u32 = fs::FILE_SHARE_READ | fs::FILE_SHARE_WRITE | fs::FILE_SHARE_DELETE;
/// Bit 29 of a reparse tag: the reparse point names another file (symlink, junction/mount point, WSL symlink).
const NAME_SURROGATE: u32 = 0x2000_0000;
/// `FILE_RENAME_FLAG_IGNORE_READONLY_ATTRIBUTE` (Windows 10 1809): replace a read-only target, as POSIX rename does.
const RENAME_IGNORE_READONLY: u32 = 0x40;

pub use ntfs::{FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN};

/// An NTSTATUS as a Win32 error code. Two are mapped by hand to the errno the POSIX layer reports:
/// `STATUS_FILE_IS_A_DIRECTORY` (`ERROR_ACCESS_DENIED` otherwise) is EISDIR, `STATUS_DELETE_PENDING` (a name
/// that is going away) is ENOENT.
pub fn status_error(status: NTSTATUS) -> OsError {
    match status {
        f::STATUS_FILE_IS_A_DIRECTORY => OsError(f::ERROR_DIRECTORY_NOT_SUPPORTED),
        f::STATUS_DELETE_PENDING => OsError(f::ERROR_FILE_NOT_FOUND),
        _ => OsError(unsafe { f::RtlNtStatusToDosError(status) }),
    }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

/// `NtCreateFile(RootDirectory = dir, name)`. `name` is one component (the callers check that); an empty name
/// reopens `dir` itself. `FILE_OPEN_REPARSE_POINT` and synchronous I/O are always added.
pub fn open_at_wide(dir: &OwnedHandle, name: &[u16], access: u32, disposition: u32, options: u32) -> Result<OwnedHandle, OsError> {
    let bytes = u16::try_from(name.len() * 2).map_err(|_| OsError(f::ERROR_FILENAME_EXCED_RANGE))?;
    let object_name = UNICODE_STRING { Length: bytes, MaximumLength: bytes, Buffer: name.as_ptr() as *mut u16 };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: raw(dir),
        ObjectName: &object_name,
        Attributes: f::OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: every pointer refers to a live local for the duration of the call; the handle is owned on success.
    let status = unsafe {
        ntfs::NtCreateFile(
            &mut handle,
            access | fs::SYNCHRONIZE,
            &attributes,
            &mut io,
            std::ptr::null(),
            fs::FILE_ATTRIBUTE_NORMAL,
            SHARE_ALL,
            disposition,
            options | ntfs::FILE_OPEN_REPARSE_POINT | ntfs::FILE_SYNCHRONOUS_IO_NONALERT,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(status_error(status));
    }
    // SAFETY: NtCreateFile succeeded, so `handle` is a new handle nobody else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

/// `CreateFileW` on an absolute (verbatim) path, for roots only, never following a reparse point in the last
/// component. `directory` adds `FILE_FLAG_BACKUP_SEMANTICS`, which opening a directory needs.
pub fn open_path(path: &Path, access: u32, directory: bool) -> Result<OwnedHandle, OsError> {
    let wide = wide_path(path);
    let mut flags = fs::FILE_FLAG_OPEN_REPARSE_POINT;
    if directory {
        flags |= fs::FILE_FLAG_BACKUP_SEMANTICS;
    }
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    let handle = unsafe { fs::CreateFileW(wide.as_ptr(), access | fs::SYNCHRONIZE, SHARE_ALL, std::ptr::null(), fs::OPEN_EXISTING, flags, std::ptr::null_mut()) };
    if handle == f::INVALID_HANDLE_VALUE {
        return Err(OsError::last());
    }
    // SAFETY: CreateFileW succeeded.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

pub fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// What an entry is, from its attributes and reparse tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Directory,
    /// A name-surrogate reparse point: symlink, junction or mount point, WSL symlink.
    Symlink,
    /// Any other reparse point (deduplicated or app-execution-link files, exposed cloud placeholders): refused too.
    Other,
}

pub fn kind_of(attributes: u32, reparse_tag: u32) -> Kind {
    if attributes & fs::FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        if reparse_tag & NAME_SURROGATE != 0 { Kind::Symlink } else { Kind::Other }
    } else if attributes & fs::FILE_ATTRIBUTE_DIRECTORY != 0 {
        Kind::Directory
    } else {
        Kind::File
    }
}

pub fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::File => "file",
        Kind::Directory => "directory",
        Kind::Symlink => "symlink",
        Kind::Other => "other",
    }
}

fn query<T: Default>(handle: &OwnedHandle, class: fs::FILE_INFO_BY_HANDLE_CLASS) -> Result<T, OsError> {
    let mut info = T::default();
    // SAFETY: `info` is a properly sized and aligned buffer for `class`.
    let ok = unsafe { fs::GetFileInformationByHandleEx(raw(handle), class, (&mut info as *mut T).cast(), size_of::<T>() as u32) };
    if ok == 0 { Err(OsError::last()) } else { Ok(info) }
}

/// `(FileAttributes, ReparseTag)` of an open handle.
pub fn attr_tag(handle: &OwnedHandle) -> Result<(u32, u32), OsError> {
    let info: fs::FILE_ATTRIBUTE_TAG_INFO = query(handle, fs::FileAttributeTagInfo)?;
    Ok((info.FileAttributes, info.ReparseTag))
}

pub fn kind(handle: &OwnedHandle) -> Result<Kind, OsError> {
    let (attributes, tag) = attr_tag(handle)?;
    Ok(kind_of(attributes, tag))
}

/// Size in bytes (end of file; 0 for directories, as Node reports on Windows).
pub fn size(handle: &OwnedHandle) -> Result<u64, OsError> {
    let info: fs::FILE_STANDARD_INFO = query(handle, fs::FileStandardInfo)?;
    Ok(info.EndOfFile.max(0) as u64)
}

/// Last write time as Node's `Stats.mtimeMs` on Windows: libuv splits the FILETIME into seconds and nanoseconds
/// since 1970, and Node computes `sec * 1e3 + nsec / 1e6`, as the POSIX layer does with `st_mtim`.
pub fn mtime_ms(handle: &OwnedHandle) -> Result<f64, OsError> {
    let info: fs::FILE_BASIC_INFO = query(handle, fs::FileBasicInfo)?;
    Ok(filetime_ms(info.LastWriteTime))
}

pub fn filetime_ms(filetime: i64) -> f64 {
    const UNIX_EPOCH: i64 = 116_444_736_000_000_000;
    let since = filetime - UNIX_EPOCH;
    let sec = since.div_euclid(10_000_000);
    let nsec = since.rem_euclid(10_000_000) * 100;
    sec as f64 * 1000.0 + nsec as f64 / 1_000_000.0
}

/// One directory entry. `wide` is the exact on-disk name (it may not be valid UTF-16); `name` is its lossy decoding.
pub struct Entry {
    pub name: String,
    pub wide: Vec<u16>,
    pub kind: Kind,
    pub size: u64,
}

/// Lists a directory handle (opened with `FILE_LIST_DIRECTORY`), without `.` and `..`, from the start.
///
/// The enumeration position belongs to the file object, which duplicated handles share (the vault root is listed
/// through duplicates, `walk::reopen`), so listings are serialized: each one restarts and runs to the end under
/// the lock.
pub fn read_dir(dir: &OwnedHandle) -> Result<Vec<Entry>, OsError> {
    static ENUMERATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one_at_a_time = ENUMERATION.lock().unwrap_or_else(|p| p.into_inner());
    // u64 storage keeps FILE_FULL_DIR_INFO (which holds i64 fields) aligned.
    let mut buf = vec![0u64; 64 * 1024 / 8];
    let mut out = Vec::new();
    let mut class = fs::FileFullDirectoryRestartInfo;
    loop {
        // SAFETY: `buf` is writable for its full length.
        let ok = unsafe { fs::GetFileInformationByHandleEx(raw(dir), class, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32) };
        if ok == 0 {
            let error = OsError::last();
            if error.0 == f::ERROR_NO_MORE_FILES {
                return Ok(out);
            }
            return Err(error);
        }
        class = fs::FileFullDirectoryInfo;
        let base = buf.as_ptr().cast::<u8>();
        let mut offset = 0usize;
        loop {
            // SAFETY: the system wrote a chain of FILE_FULL_DIR_INFO records into `buf`, each 8-byte aligned, linked
            // by NextEntryOffset; the name has FileNameLength bytes after the fixed part.
            let (next, entry) = unsafe {
                let info = base.add(offset).cast::<fs::FILE_FULL_DIR_INFO>();
                let name_ptr = std::ptr::addr_of!((*info).FileName).cast::<u16>();
                let wide = std::slice::from_raw_parts(name_ptr, (*info).FileNameLength as usize / 2).to_vec();
                // For a reparse point, EaSize holds the reparse tag (EAs and reparse points exclude each other).
                let kind = kind_of((*info).FileAttributes, (*info).EaSize);
                let size = if kind == Kind::File { (*info).EndOfFile.max(0) as u64 } else { 0 };
                ((*info).NextEntryOffset as usize, (wide, kind, size))
            };
            let (wide, kind, size) = entry;
            if wide != [b'.' as u16] && wide != [b'.' as u16, b'.' as u16] {
                out.push(Entry { name: String::from_utf16_lossy(&wide), wide, kind, size });
            }
            if next == 0 {
                break;
            }
            offset += next;
        }
    }
}

fn set_info(handle: &OwnedHandle, class: fs::FILE_INFO_BY_HANDLE_CLASS, data: *const std::ffi::c_void, size: usize) -> Result<(), OsError> {
    // SAFETY: `data` points to `size` readable bytes laid out for `class`.
    let ok = unsafe { fs::SetFileInformationByHandle(raw(handle), class, data, size as u32) };
    if ok == 0 { Err(OsError::last()) } else { Ok(()) }
}

/// The information class is not supported here (older Windows, FAT/exFAT, some network file systems).
fn unsupported(error: OsError) -> bool {
    matches!(error.0, f::ERROR_INVALID_PARAMETER | f::ERROR_NOT_SUPPORTED | f::ERROR_INVALID_FUNCTION)
}

/// Renames the open file `handle` (opened with DELETE) to `name` inside `dst_dir`, the `renameat` of this layer: the
/// target is named relative to a directory handle (`FILE_RENAME_INFO.RootDirectory`), never by a path.
///
/// `replace`: replace an existing target atomically, with POSIX semantics where the volume supports them (an open
/// target is replaced too, and a read-only one, as `rename(2)` does). Otherwise the rename fails with
/// ERROR_ALREADY_EXISTS if the target exists, atomically (no window in which both names exist).
pub fn rename(handle: &OwnedHandle, dst_dir: &OwnedHandle, name: &[u16], replace: bool) -> Result<(), OsError> {
    let header = std::mem::offset_of!(fs::FILE_RENAME_INFO, FileName);
    let size = header + (name.len() + 1) * 2;
    let mut buf = vec![0u64; size.div_ceil(8)];
    let info = buf.as_mut_ptr().cast::<fs::FILE_RENAME_INFO>();
    let fill = |flags: u32, ex: bool| {
        // SAFETY: `buf` is zeroed, aligned and large enough for the header plus the name and a NUL.
        unsafe {
            if ex {
                (*info).Anonymous.Flags = flags;
            } else {
                (*info).Anonymous.Flags = 0;
                (*info).Anonymous.ReplaceIfExists = replace;
            }
            (*info).RootDirectory = raw(dst_dir);
            (*info).FileNameLength = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(name.as_ptr(), std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(), name.len());
        }
    };
    let flags = if replace { FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS | RENAME_IGNORE_READONLY } else { 0 };
    fill(flags, true);
    match set_info(handle, fs::FileRenameInfoEx, info.cast(), size) {
        Err(error) if unsupported(error) => {
            fill(0, false);
            set_info(handle, fs::FileRenameInfo, info.cast(), size)
        }
        other => other,
    }
}

/// Deletes the open file or empty directory `handle` (opened with DELETE): the name goes when the handle closes.
/// POSIX semantics (the name is gone at once even if other programs hold the file open) and read-only files are
/// deleted, as `unlink(2)` does, where the volume supports it. A reparse point opened as itself is deleted, never
/// its target.
pub fn delete(handle: &OwnedHandle) -> Result<(), OsError> {
    let flags = fs::FILE_DISPOSITION_FLAG_DELETE | fs::FILE_DISPOSITION_FLAG_POSIX_SEMANTICS | fs::FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
    let ex = fs::FILE_DISPOSITION_INFO_EX { Flags: flags };
    match set_info(handle, fs::FileDispositionInfoEx, (&ex as *const fs::FILE_DISPOSITION_INFO_EX).cast(), size_of::<fs::FILE_DISPOSITION_INFO_EX>()) {
        Err(error) if unsupported(error) => {
            let classic = fs::FILE_DISPOSITION_INFO { DeleteFile: true };
            set_info(handle, fs::FileDispositionInfo, (&classic as *const fs::FILE_DISPOSITION_INFO).cast(), size_of::<fs::FILE_DISPOSITION_INFO>())
        }
        other => other,
    }
}

/// The handle's final path (`\\?\C:\...` or `\\?\UNC\...`), with every link resolved by the system.
pub fn final_path(handle: &OwnedHandle) -> Result<PathBuf, OsError> {
    use std::os::windows::ffi::OsStringExt;
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: `buf` is writable for its length.
        let n = unsafe { fs::GetFinalPathNameByHandleW(raw(handle), buf.as_mut_ptr(), buf.len() as u32, fs::FILE_NAME_NORMALIZED | fs::VOLUME_NAME_DOS) } as usize;
        if n == 0 {
            return Err(OsError::last());
        }
        if n < buf.len() {
            buf.truncate(n);
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buf)));
        }
        buf.resize(n + 1, 0);
    }
}
