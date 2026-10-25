//! The local socket `thoth-mcp` connects to (ADR-0021 rule 1): a Unix socket, `0600` in a `0700` folder of the app
//! data folder that the host checks is the user's own. One request per connection, one JSON line each way.
//!
//! Windows (a named pipe with an owner-only ACL) is not built yet: starting fails with `UNAVAILABLE`.
use super::Inner;
use crate::error::{HostError, HostResult};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const SOCKET_NAME: &str = "thoth.sock";

/// A listening socket and its accept thread. Dropping it stops listening and removes the socket file.
pub struct Listener {
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(unix)]
    stop: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(unix)]
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(unix)]
mod unix {
    use super::*;
    use crate::mcp::{MAX_CONNECTIONS, MAX_REQUEST, private_dir};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// The longest socket path every Unix takes (`sun_path` is 104 bytes on macOS, 108 on Linux, with its NUL).
    const MAX_SOCKET_PATH: usize = 103;

    impl Listener {
        pub fn start(dir: &Path, inner: Arc<Inner>) -> HostResult<Self> {
            private_dir(dir)?;
            let path = dir.join(SOCKET_NAME);
            if path.as_os_str().len() > MAX_SOCKET_PATH {
                return Err(HostError::new("UNAVAILABLE", format!("The app data folder's path is too long for a local socket ({} bytes)", path.as_os_str().len())));
            }
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_socket() => {
                    // Another Thoth (a second copy of the app on the same data folder) answers already: leave it be.
                    if UnixStream::connect(&path).is_ok() {
                        return Err(HostError::new("BUSY", "Another copy of Thoth answers connected apps already"));
                    }
                    std::fs::remove_file(&path).map_err(|e| HostError::io(&e, "unlink", &path.to_string_lossy()))?;
                }
                Ok(_) => return Err(HostError::new("UNAVAILABLE", format!("Something that is not Thoth's socket is at {}", path.display()))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(HostError::io(&e, "lstat", &path.to_string_lossy())),
            }
            let listener = UnixListener::bind(&path).map_err(|e| HostError::io(&e, "bind", &path.to_string_lossy()))?;
            // The folder is 0700 already, so nobody else could reach the socket between bind and this.
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| HostError::io(&e, "chmod", &path.to_string_lossy()))?;
            let stop = Arc::new(AtomicBool::new(false));
            let active = Arc::new(AtomicUsize::new(0));
            let thread = {
                let stop = stop.clone();
                std::thread::Builder::new()
                    .name("thoth-mcp-accept".into())
                    .spawn(move || {
                        for stream in listener.incoming() {
                            if stop.load(Ordering::SeqCst) {
                                break;
                            }
                            let Ok(stream) = stream else { continue };
                            if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                                active.fetch_sub(1, Ordering::SeqCst);
                                let _ = reply(&stream, &super::super::error_line(&HostError::new("BUSY", "Thoth is answering too many requests: try again")));
                                continue;
                            }
                            let (inner, done) = (inner.clone(), active.clone());
                            let spawned = std::thread::Builder::new().name("thoth-mcp-request".into()).spawn(move || {
                                serve(&inner, stream);
                                done.fetch_sub(1, Ordering::SeqCst);
                            });
                            if spawned.is_err() {
                                active.fetch_sub(1, Ordering::SeqCst);
                            }
                        }
                    })
                    .map_err(|e| HostError::internal(format!("Could not start listening: {e}")))?
            };
            Ok(Self { path, stop, thread: Some(thread) })
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Wakes the accept loop, which then sees `stop`.
            let _ = UnixStream::connect(&self.path);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn serve(inner: &Inner, stream: UnixStream) {
        let _ = stream.set_read_timeout(Some(inner.options.read_timeout));
        let _ = stream.set_write_timeout(Some(inner.options.read_timeout));
        let mut line = Vec::new();
        let read = BufReader::new(&stream).take(MAX_REQUEST as u64 + 1).read_until(b'\n', &mut line);
        let response = match read {
            Ok(_) if line.len() > MAX_REQUEST => super::super::error_line(&HostError::bad_argument("The request is too long")),
            Ok(0) => return,
            Ok(_) => inner.serve(&line),
            Err(_) => return,
        };
        let _ = reply(&stream, &response);
    }

    fn reply(mut stream: &UnixStream, line: &str) -> std::io::Result<()> {
        stream.write_all(line.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()
    }
}

#[cfg(not(unix))]
impl Listener {
    pub fn start(_dir: &Path, _inner: Arc<Inner>) -> HostResult<Self> {
        Err(HostError::new("UNAVAILABLE", "Connected apps are not available on Windows yet"))
    }
}

/// Where the socket is for a Connected apps folder (`<data>/mcp`).
pub fn socket_path(dir: &Path) -> PathBuf {
    dir.join(SOCKET_NAME)
}
