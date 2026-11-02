//! Is a Private Space on a network drive (ADR-0046)? Then the app shows a short notice: notes there work, Thoth keeps
//! its own data on this computer, and the same page should not be edited on two computers at once. Only a hint for
//! that notice; nothing else depends on it, so an answer it cannot get is "no".
use std::path::Path;

/// Is `root` (canonical) on a network file system?
pub fn on_network(root: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        let Ok(st) = rustix::fs::statfs(root) else { return false };
        let name: Vec<u8> = st.f_fstypename.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
        network_fs_name(&String::from_utf8_lossy(&name))
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(st) = rustix::fs::statfs(root) else { return false };
        // `f_type`'s integer type differs between targets.
        #[allow(clippy::unnecessary_cast)]
        let f_type = st.f_type as u64;
        network_fs_magic(f_type)
    }
    #[cfg(windows)]
    {
        windows_on_network(root)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = root;
        false
    }
}

/// macOS `statfs` `f_fstypename` (and Linux mount types) of network file systems.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn network_fs_name(name: &str) -> bool {
    matches!(name, "smbfs" | "nfs" | "cifs" | "afpfs" | "webdav" | "ftp" | "smb3" | "nfs4")
}

/// Linux `statfs` `f_type` magic numbers of network file systems (linux/magic.h, and CIFS's and SMB2's own). FUSE is
/// left out: it is network (sshfs) as often as local.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn network_fs_magic(f_type: u64) -> bool {
    const NFS: u64 = 0x6969;
    const SMB: u64 = 0x517B;
    const CIFS: u64 = 0xFF53_4D42;
    const SMB2: u64 = 0xFE53_4D42;
    const AFS: u64 = 0x5346_414F;
    const CODA: u64 = 0x7375_7245;
    const NCP: u64 = 0x564C;
    // `f_type` is signed on some targets: CIFS's magic then comes sign-extended.
    matches!(f_type & 0xFFFF_FFFF, NFS | SMB | CIFS | SMB2 | AFS | CODA | NCP)
}

/// How a Windows path starts: a UNC share (`\\server\share`, `\\?\UNC\server\share`), a drive letter (also
/// `\\?\C:`), or neither.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum WindowsRoot {
    Unc,
    Drive(char),
    Other,
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_root(path: &str) -> WindowsRoot {
    let rest = path.strip_prefix(r"\\?\").or_else(|| path.strip_prefix("//?/"));
    if let Some(rest) = rest {
        if rest.len() >= 4 && rest[..4].eq_ignore_ascii_case(r"UNC\") {
            return WindowsRoot::Unc;
        }
        return drive(rest);
    }
    if path.starts_with(r"\\.\") || path.starts_with("//./") {
        return WindowsRoot::Other;
    }
    if path.starts_with(r"\\") || path.starts_with("//") {
        return WindowsRoot::Unc;
    }
    drive(path)
}

fn drive(path: &str) -> WindowsRoot {
    let mut chars = path.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic() => WindowsRoot::Drive(letter.to_ascii_uppercase()),
        _ => WindowsRoot::Other,
    }
}

#[cfg(windows)]
fn windows_on_network(root: &Path) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows_sys::Win32::System::WindowsProgramming::DRIVE_REMOTE;
    match windows_root(&root.to_string_lossy()) {
        WindowsRoot::Unc => true,
        WindowsRoot::Drive(letter) => {
            let wide: Vec<u16> = format!("{letter}:\\").encode_utf16().chain([0]).collect();
            // SAFETY: a NUL-terminated wide string that lives across the call.
            unsafe { GetDriveTypeW(wide.as_ptr()) == DRIVE_REMOTE }
        }
        WindowsRoot::Other => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_file_system_names() {
        for name in ["smbfs", "nfs", "afpfs", "webdav", "cifs"] {
            assert!(network_fs_name(name), "{name}");
        }
        for name in ["apfs", "hfs", "exfat", "msdos", "ntfs", "ext4", "", "smbfsx"] {
            assert!(!network_fs_name(name), "{name}");
        }
    }

    #[test]
    fn network_file_system_magic_numbers() {
        for magic in [0x6969u64, 0x517B, 0xFF53_4D42, 0xFE53_4D42, 0x5346_414F] {
            assert!(network_fs_magic(magic), "{magic:#x}");
        }
        // CIFS's magic read through a signed 64-bit `f_type`.
        assert!(network_fs_magic(0xFF53_4D42u32 as i32 as i64 as u64));
        // ext4, btrfs, tmpfs, xfs, FUSE.
        for magic in [0xEF53u64, 0x9123_683E, 0x0102_1994, 0x5846_5342, 0x6573_5546] {
            assert!(!network_fs_magic(magic), "{magic:#x}");
        }
    }

    #[test]
    fn windows_paths_unc_or_drive() {
        assert_eq!(windows_root(r"\\nas\notes\Work"), WindowsRoot::Unc);
        assert_eq!(windows_root(r"\\?\UNC\nas\notes"), WindowsRoot::Unc);
        assert_eq!(windows_root(r"\\?\unc\nas\notes"), WindowsRoot::Unc);
        assert_eq!(windows_root("//nas/notes"), WindowsRoot::Unc);
        assert_eq!(windows_root(r"C:\Users\a\Notes"), WindowsRoot::Drive('C'));
        assert_eq!(windows_root(r"z:\Notes"), WindowsRoot::Drive('Z'));
        assert_eq!(windows_root(r"\\?\D:\Notes"), WindowsRoot::Drive('D'));
        assert_eq!(windows_root(r"\\.\PhysicalDrive0"), WindowsRoot::Other);
        assert_eq!(windows_root("/Users/a/Notes"), WindowsRoot::Other);
    }

    #[test]
    fn a_local_folder_is_not_on_the_network() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!on_network(dir.path()));
        assert!(!on_network(&dir.path().join("missing")));
    }
}
