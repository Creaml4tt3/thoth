//! Agent Hub process control on Windows (the POSIX side is the process group in `mod.rs`).
//!
//! Windows has no process groups to signal, so each CLI runs in its own Job Object: the CLI starts suspended
//! (`CREATE_SUSPENDED`), is put in a new job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then resumed, so every
//! process it starts (Node, ripgrep, shells, a `.cmd` shim's `cmd.exe`) is in the job from its first instruction and
//! cannot break away. Cancel, timeout, the output limit and shutdown call `TerminateJobObject`, which ends the
//! whole tree at once; the job handle is closed when the run is reaped, and if the host itself dies the system
//! closes it, which kills whatever is left (a POSIX process group can outlive its parent).
//!
//! Differences from POSIX: there is no graceful SIGTERM first (console control events need a shared console, which a
//! GUI app's hidden children do not have), so "term" ends the tree immediately with exit code `TERMINATED_EXIT_CODE`
//! and no signal number. The CLI works in a private scratch folder that is deleted after the run, so nothing of the
//! user's is left half-written. Children also get `CREATE_NO_WINDOW`, so no console window flashes up.
//!
//! Jobs are keyed by process id. A process id is not reused while a handle to the process is open, and the host's
//! `Child` keeps one until the run is reaped, after the final kill removed the job here.
use std::collections::HashMap;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::sync::{Mutex, MutexGuard, OnceLock};
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

/// The exit code of a CLI the host stopped (`agent.cancel`, timeout, output limit, shutdown).
pub const TERMINATED_EXIT_CODE: u32 = 1;

fn jobs() -> MutexGuard<'static, HashMap<u32, OwnedHandle>> {
    static JOBS: OnceLock<Mutex<HashMap<u32, OwnedHandle>>> = OnceLock::new();
    JOBS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner())
}

/// Before `spawn`: start suspended (see `adopt`) and without a console window.
pub fn prepare(command: &mut Command) {
    command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
}

/// After `spawn`: puts the suspended child in a new kill-on-close job, then lets it run. On failure the child is
/// killed (it never ran a single instruction) and the error returned.
pub fn adopt(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id();
    let result = (|| {
        let job = new_job()?;
        // SAFETY: both handles are live; the child is suspended, so it has started nothing yet.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle() as HANDLE, child.as_raw_handle() as HANDLE) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        jobs().insert(pid, job);
        resume(pid)
    })();
    if result.is_err() {
        jobs().remove(&pid);
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

/// Ends the CLI's whole process tree. `kill` (the final kill, after the CLI exited or at shutdown) also releases
/// the job; a "term" keeps it so the final kill still reaches stragglers.
pub fn signal(pid: i32, kill: bool) {
    let Ok(pid) = u32::try_from(pid) else { return };
    let mut jobs = jobs();
    let job = if kill { jobs.remove(&pid) } else { jobs.get(&pid).and_then(|j| j.try_clone().ok()) };
    drop(jobs);
    if let Some(job) = job {
        // SAFETY: `job` is a live job handle owned here.
        unsafe { TerminateJobObject(job.as_raw_handle() as HANDLE, TERMINATED_EXIT_CODE) };
    }
}

fn new_job() -> std::io::Result<OwnedHandle> {
    // SAFETY: an unnamed job with default security.
    let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: CreateJobObjectW succeeded.
    let job = unsafe { OwnedHandle::from_raw_handle(raw as _) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `limits` is the structure this information class takes.
    let ok = unsafe {
        SetInformationJobObject(
            job.as_raw_handle() as HANDLE,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(job)
}

/// Resumes the threads of a process created suspended (it has exactly one, its main thread).
fn resume(pid: u32) -> std::io::Result<()> {
    // SAFETY: a snapshot of all threads; closed by OwnedHandle.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: CreateToolhelp32Snapshot succeeded.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot as _) };
    let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
    let mut resumed = 0;
    // SAFETY: `entry` has dwSize set, as Thread32First/Next require.
    let mut more = unsafe { Thread32First(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: a thread of our own child process.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: OpenThread succeeded.
            let thread = unsafe { OwnedHandle::from_raw_handle(thread as _) };
            // SAFETY: a live thread handle with THREAD_SUSPEND_RESUME.
            if unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) } == u32::MAX {
                return Err(std::io::Error::last_os_error());
            }
            resumed += 1;
        }
        // SAFETY: as above.
        more = unsafe { Thread32Next(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
    }
    if resumed == 0 {
        return Err(std::io::Error::other("the agent CLI has no thread to resume"));
    }
    Ok(())
}
