//! The local connection on Windows (ADR-0021 rule 1): a named pipe in place of the Unix socket, used by the app
//! (`PipeListener`) and by `thoth-mcp` (`connect`). One request per connection, one JSON line each way, as on Unix.
//!
//! - The pipe's name comes from the socket path `thoth-mcp` is given (`--socket <data>\mcp\thoth.sock`), so the setup
//!   an app pastes is the same on every system. No file is made at that path.
//! - Only this user may open it: the pipe's DACL grants the user's SID alone, remote clients are refused, and the app
//!   makes the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a pipe someone else made first is never shared.
//! - `thoth-mcp` connects only to a pipe whose server process runs as the same user (a pipe made by another user while
//!   Thoth was closed is refused), and with `SECURITY_IDENTIFICATION`, so that server could not act as this user anyway.
//! - Reads and writes are overlapped with a deadline, so a client that stops sending cannot hold a connection.
use crate::error::{HostError, HostResult};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{self as f, HANDLE};
use windows_sys::Win32::Security::{self as sec, Authorization as auth};
use windows_sys::Win32::Storage::FileSystem as fs;
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes as pipes;
use windows_sys::Win32::System::Threading as th;

const BUFFER: u32 = 64 * 1024;

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error() -> std::io::Error {
    std::io::Error::last_os_error()
}

/// The pipe for a socket path: the same name for the same path, whatever its letter case.
pub fn pipe_name(socket: &Path) -> String {
    let digest = Sha256::digest(socket.to_string_lossy().to_lowercase().as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!(r"\\.\pipe\thoth-mcp-{hex}")
}

/// A manual-reset event, unset.
fn event() -> std::io::Result<OwnedHandle> {
    // SAFETY: no attributes and no name; the handle is checked before it is owned.
    let handle = unsafe { th::CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if handle.is_null() {
        return Err(last_error());
    }
    // SAFETY: CreateEventW succeeded, so `handle` is a new handle nobody else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

/// One SID a token holds (`TokenUser` or `TokenOwner`), as text (`S-1-5-21-…`).
fn token_sid(token: HANDLE, class: sec::TOKEN_INFORMATION_CLASS) -> std::io::Result<String> {
    let mut size = 0u32;
    // SAFETY: a size query: no buffer, the needed size is written to `size`.
    unsafe { sec::GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut size) };
    if size == 0 {
        return Err(last_error());
    }
    // u64s, so the TOKEN_USER or TOKEN_OWNER (which hold a pointer) is aligned.
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    // SAFETY: `buffer` is at least `size` bytes and lives past every use of the SID inside it.
    if unsafe { sec::GetTokenInformation(token, class, buffer.as_mut_ptr().cast(), size, &mut size) } == 0 {
        return Err(last_error());
    }
    // SAFETY: GetTokenInformation filled the structure for `class` at the start of `buffer`; both start with the PSID.
    let sid = unsafe {
        if class == sec::TokenOwner { (*buffer.as_ptr().cast::<sec::TOKEN_OWNER>()).Owner } else { (*buffer.as_ptr().cast::<sec::TOKEN_USER>()).User.Sid }
    };
    sid_text(sid)
}

fn sid_text(sid: sec::PSID) -> std::io::Result<String> {
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: `sid` is a valid SID; the string is allocated by the call and freed below.
    if unsafe { auth::ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(last_error());
    }
    // SAFETY: a NUL-terminated string from ConvertSidToStringSidW.
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    let out = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    unsafe { f::LocalFree(text.cast()) };
    Ok(out)
}

fn open_token(process: HANDLE) -> std::io::Result<OwnedHandle> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `token` receives a new handle, owned right after.
    if unsafe { th::OpenProcessToken(process, sec::TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error());
    }
    // SAFETY: OpenProcessToken succeeded.
    Ok(unsafe { OwnedHandle::from_raw_handle(token as _) })
}

/// The user SID of a process.
fn process_user(process: HANDLE) -> std::io::Result<String> {
    token_sid(raw(&open_token(process)?), sec::TokenUser)
}

/// This process's user SID.
pub fn current_user() -> std::io::Result<String> {
    // SAFETY: the pseudo-handle of this process needs no closing.
    process_user(unsafe { th::GetCurrentProcess() })
}

/// The owners this process gives what it makes: the user, and the default owner of its token (the Administrators
/// group when it runs elevated).
fn my_owners() -> Vec<String> {
    // SAFETY: the pseudo-handle of this process needs no closing.
    let Ok(token) = open_token(unsafe { th::GetCurrentProcess() }) else { return Vec::new() };
    [sec::TokenUser, sec::TokenOwner].into_iter().filter_map(|class| token_sid(raw(&token), class).ok()).collect()
}

/// Whether `path` is a folder (`dir`) or file this process's user owns, and not a link or junction to somewhere else.
// shortcut: checks the owner, not the DACL; the app data folder's inherited ACL is the user's own. Read the DACL if
// Thoth ever keeps this folder anywhere else.
pub fn owned_by_me(path: &Path, dir: bool) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false };
    if meta.file_type().is_symlink() || (if dir { !meta.is_dir() } else { !meta.is_file() }) {
        return false;
    }
    let name = wide(&path.to_string_lossy());
    let (mut owner, mut descriptor): (sec::PSID, sec::PSECURITY_DESCRIPTOR) = (std::ptr::null_mut(), std::ptr::null_mut());
    // SAFETY: `name` is NUL-terminated; `owner` points into `descriptor`, freed below after its last use.
    let status = unsafe {
        auth::GetNamedSecurityInfoW(
            name.as_ptr(),
            auth::SE_FILE_OBJECT,
            sec::OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != f::ERROR_SUCCESS {
        return false;
    }
    let same = sid_text(owner).is_ok_and(|sid| my_owners().contains(&sid));
    unsafe { f::LocalFree(descriptor.cast()) };
    same
}

/// One end of a connected pipe. Every read and write waits until the deadline at most (none: as long as it takes).
pub struct PipeStream {
    handle: OwnedHandle,
    deadline: Cell<Option<Instant>>,
}

impl PipeStream {
    /// From now on, reads and writes fail with `TimedOut` after `until`.
    pub fn set_deadline(&self, until: Option<Instant>) {
        self.deadline.set(until);
    }

    /// One overlapped read or write, waited for until the deadline; a timed-out one is cancelled before returning.
    fn io(&self, buffer: *mut u8, len: usize, write: bool) -> std::io::Result<usize> {
        let len = u32::try_from(len).unwrap_or(u32::MAX);
        let done_event = event()?;
        // SAFETY: OVERLAPPED is plain data; all zero is its documented start state.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = raw(&done_event);
        let handle = raw(&self.handle);
        let mut moved = 0u32;
        // SAFETY: `buffer` holds `len` bytes and, like `overlapped`, outlives the operation: it is waited for (or
        // cancelled and waited for) below before this returns.
        let started = unsafe {
            if write { fs::WriteFile(handle, buffer, len, &mut moved, &mut overlapped) } else { fs::ReadFile(handle, buffer, len, &mut moved, &mut overlapped) }
        };
        if started == 0 {
            let error = unsafe { f::GetLastError() };
            if error != f::ERROR_IO_PENDING {
                return finish(error, write);
            }
        }
        let wait = match self.deadline.get() {
            None => th::INFINITE,
            Some(until) => u32::try_from(until.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(th::INFINITE - 1),
        };
        // SAFETY: the event belongs to this operation.
        if unsafe { th::WaitForSingleObject(raw(&done_event), wait) } != f::WAIT_OBJECT_0 {
            unsafe {
                CancelIoEx(handle, &overlapped);
                GetOverlappedResult(handle, &overlapped, &mut moved, 1);
            }
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        // SAFETY: the operation has completed.
        if unsafe { GetOverlappedResult(handle, &overlapped, &mut moved, 0) } == 0 {
            return finish(unsafe { f::GetLastError() }, write);
        }
        Ok(moved as usize)
    }
}

/// A failed read at the other end's close is the end of the stream; anything else is an error.
fn finish(error: u32, write: bool) -> std::io::Result<usize> {
    if !write && matches!(error, f::ERROR_BROKEN_PIPE | f::ERROR_PIPE_NOT_CONNECTED) {
        return Ok(0);
    }
    Err(std::io::Error::from_raw_os_error(error as i32))
}

impl Read for &PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        self.io(buf.as_mut_ptr(), buf.len(), false)
    }
}

impl Write for &PipeStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        // WriteFile only reads from the buffer.
        self.io(buf.as_ptr().cast_mut(), buf.len(), true)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Read for PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        (&*self).read(buf)
    }
}

impl Write for PipeStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        (&*self).write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Why `connect` gave no stream.
#[derive(Debug, PartialEq, Eq)]
pub enum ConnectError {
    /// Nothing listens: Thoth is closed, or Connected apps is off.
    NotRunning,
    /// Something listens there that is not this user's.
    NotOurs,
}

/// Connects to the app's pipe for `socket`, if it is this user's.
pub fn connect(socket: &Path) -> Result<PipeStream, ConnectError> {
    let name = wide(&pipe_name(socket));
    let mut handle = f::INVALID_HANDLE_VALUE;
    for _ in 0..2 {
        // SAFETY: `name` is NUL-terminated; the handle is checked before it is owned.
        handle = unsafe {
            fs::CreateFileW(
                name.as_ptr(),
                f::GENERIC_READ | f::GENERIC_WRITE,
                0,
                std::ptr::null(),
                fs::OPEN_EXISTING,
                fs::FILE_FLAG_OVERLAPPED | fs::SECURITY_SQOS_PRESENT | fs::SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        };
        if handle != f::INVALID_HANDLE_VALUE {
            break;
        }
        // Every instance busy for a moment: the app makes the next one at once.
        if unsafe { f::GetLastError() } != f::ERROR_PIPE_BUSY || unsafe { pipes::WaitNamedPipeW(name.as_ptr(), 2000) } == 0 {
            break;
        }
    }
    if handle == f::INVALID_HANDLE_VALUE {
        return Err(match unsafe { f::GetLastError() } {
            f::ERROR_ACCESS_DENIED => ConnectError::NotOurs,
            _ => ConnectError::NotRunning,
        });
    }
    // SAFETY: CreateFileW succeeded.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle as _) };
    if !server_is_me(&handle) {
        return Err(ConnectError::NotOurs);
    }
    Ok(PipeStream { handle, deadline: Cell::new(None) })
}

/// Whether the process at the other end of `pipe` runs as this user.
fn server_is_me(pipe: &OwnedHandle) -> bool {
    let mut pid = 0u32;
    // SAFETY: `pipe` is a connected client end.
    if unsafe { pipes::GetNamedPipeServerProcessId(raw(pipe), &mut pid) } == 0 {
        return false;
    }
    // SAFETY: the handle is checked before it is owned.
    let process = unsafe { th::OpenProcess(th::PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    // SAFETY: OpenProcess succeeded.
    let process = unsafe { OwnedHandle::from_raw_handle(process as _) };
    process_user(raw(&process)).ok().zip(current_user().ok()).is_some_and(|(a, b)| a == b)
}

/// Wakes a `PipeListener` blocked in `accept`, from another thread; it then returns `None` for good.
#[derive(Clone)]
pub struct Stopper(Arc<OwnedHandle>);

impl Stopper {
    pub fn stop(&self) {
        // SAFETY: the event lives as long as this Arc.
        unsafe { th::SetEvent(raw(&self.0)) };
    }
}

/// The app's end: makes pipe instances and hands out each connection.
pub struct PipeListener {
    name: Vec<u16>,
    /// The DACL every instance gets (only this user), from `LocalAlloc`; freed on drop.
    descriptor: sec::PSECURITY_DESCRIPTOR,
    /// The instance waiting for the next client.
    next: OwnedHandle,
    stop: Stopper,
}

// SAFETY: `descriptor` is a heap block only this listener reads and frees; nothing in it is tied to a thread.
unsafe impl Send for PipeListener {}

impl PipeListener {
    /// Makes the pipe for `socket`. `BUSY` when another copy of Thoth has it, `UNAVAILABLE` when something else does.
    pub fn bind(socket: &Path) -> HostResult<Self> {
        let shown = pipe_name(socket);
        let me = current_user().map_err(|e| HostError::io(&e, "token", &shown))?;
        let sddl = wide(&format!("D:P(A;;GA;;;{me})"));
        let mut descriptor: sec::PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `sddl` is NUL-terminated; the descriptor is allocated by the call and freed on drop.
        if unsafe { auth::ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), auth::SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()) }
            == 0
        {
            return Err(HostError::io(&last_error(), "security", &shown));
        }
        let name = wide(&shown);
        let first = match instance(&name, descriptor, true) {
            Ok(first) => first,
            Err(error) => {
                unsafe { f::LocalFree(descriptor.cast()) };
                return Err(match connect(socket) {
                    Ok(_) => HostError::new("BUSY", "Another copy of Thoth answers connected apps already"),
                    Err(_) if error.raw_os_error() == Some(f::ERROR_ACCESS_DENIED as i32) => {
                        HostError::new("UNAVAILABLE", format!("Something that is not Thoth has the pipe {shown}"))
                    }
                    Err(_) => HostError::io(&error, "pipe", &shown),
                });
            }
        };
        let stop = match event() {
            Ok(stop) => Stopper(Arc::new(stop)),
            Err(error) => {
                unsafe { f::LocalFree(descriptor.cast()) };
                return Err(HostError::io(&error, "event", &shown));
            }
        };
        Ok(Self { name, descriptor, next: first, stop })
    }

    pub fn stopper(&self) -> Stopper {
        self.stop.clone()
    }

    /// Waits for the next client. `None` once stopped. The next instance is made before the connected one is handed
    /// out, so the name is never free for anyone else to take.
    pub fn accept(&mut self) -> std::io::Result<Option<PipeStream>> {
        let connected_event = event()?;
        // SAFETY: plain data, all zero to start.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = raw(&connected_event);
        let handle = raw(&self.next);
        // SAFETY: `overlapped` outlives the operation: it is waited for, or cancelled and waited for, below.
        if unsafe { pipes::ConnectNamedPipe(handle, &mut overlapped) } == 0 {
            match unsafe { f::GetLastError() } {
                f::ERROR_PIPE_CONNECTED => {}
                f::ERROR_IO_PENDING => {
                    let waits = [raw(&connected_event), raw(&self.stop.0)];
                    // SAFETY: both handles are open events.
                    let woke = unsafe { th::WaitForMultipleObjects(2, waits.as_ptr(), 0, th::INFINITE) };
                    let mut ignored = 0u32;
                    if woke != f::WAIT_OBJECT_0 {
                        unsafe {
                            CancelIoEx(handle, &overlapped);
                            GetOverlappedResult(handle, &overlapped, &mut ignored, 1);
                        }
                        return Ok(None);
                    }
                    if unsafe { GetOverlappedResult(handle, &overlapped, &mut ignored, 0) } == 0 {
                        return Err(self.reset(last_error()));
                    }
                }
                // A client that came and went already (ERROR_NO_DATA), or anything else: this instance waits again.
                error => return Err(self.reset(std::io::Error::from_raw_os_error(error as i32))),
            }
        }
        let next = instance(&self.name, self.descriptor, false).map_err(|e| self.reset(e))?;
        let connected = std::mem::replace(&mut self.next, next);
        Ok(Some(PipeStream { handle: connected, deadline: Cell::new(None) }))
    }

    /// Frees the waiting instance for the next client after a failed connection, and gives back `error`.
    fn reset(&self, error: std::io::Error) -> std::io::Error {
        // SAFETY: `next` is a server end; disconnecting it lets ConnectNamedPipe use it again.
        unsafe { pipes::DisconnectNamedPipe(raw(&self.next)) };
        error
    }
}

impl Drop for PipeListener {
    fn drop(&mut self) {
        unsafe { f::LocalFree(self.descriptor.cast()) };
    }
}

/// One pipe instance: byte mode, overlapped, this user only, local clients only.
fn instance(name: &[u16], descriptor: sec::PSECURITY_DESCRIPTOR, first: bool) -> std::io::Result<OwnedHandle> {
    let attributes = sec::SECURITY_ATTRIBUTES { nLength: size_of::<sec::SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
    let open = fs::PIPE_ACCESS_DUPLEX | fs::FILE_FLAG_OVERLAPPED | if first { fs::FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
    let mode = pipes::PIPE_TYPE_BYTE | pipes::PIPE_READMODE_BYTE | pipes::PIPE_WAIT | pipes::PIPE_REJECT_REMOTE_CLIENTS;
    // SAFETY: `name` is NUL-terminated and `attributes` points at a live descriptor.
    let handle = unsafe { pipes::CreateNamedPipeW(name.as_ptr(), open, mode, pipes::PIPE_UNLIMITED_INSTANCES, BUFFER, BUFFER, 0, &attributes) };
    if handle == f::INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    // SAFETY: CreateNamedPipeW succeeded.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

/// Waits (until `until` at most) for the client to close its end, reading and dropping anything it still sends, so
/// the answer written before is not lost by closing first.
pub fn linger(stream: &PipeStream, until: Instant) {
    stream.set_deadline(Some(until));
    let mut sink = [0u8; 4096];
    let mut reader = stream;
    while let Ok(n) = reader.read(&mut sink) {
        if n == 0 {
            break;
        }
    }
}

/// How long `linger` waits at most.
pub const LINGER: Duration = Duration::from_secs(2);
