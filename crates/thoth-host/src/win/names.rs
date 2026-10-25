//! Windows name rules for path segments the webview sends. The NT API would accept most of these names (it does
//! not apply Win32 rules), which would create files Explorer and other programs cannot open or delete, or reach
//! something that is not a plain file: `a.md:x` names an alternate data stream of `a.md`. They match the rules the
//! tree applies to new names (`entryNameProblem` in packages/local-store/src/names.ts), a little stricter:
//! `COM0`/`LPT0` and the superscript-digit ports are reserved too, as Microsoft documents.
//!
//! No such entry can exist on a Windows volume (Win32 programs cannot create it), so a lookup of one is "not found"
//! and a create is refused as an unsafe path (`vault_fs_windows.rs`).

/// Why `segment` is not a usable Windows name, or None. `segment` is one component, already checked for `/`, `\`,
/// NUL, `.` and `..` by `paths`.
pub fn segment_problem(segment: &str) -> Option<&'static str> {
    if segment.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20) {
        return Some("character not allowed in a Windows name");
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Some("Windows names cannot end with a dot or a space");
    }
    if is_device_name(segment) {
        return Some("reserved Windows device name");
    }
    None
}

/// `CON`, `NUL`, `COM1`... with or without an extension, in any case, with spaces before the extension.
fn is_device_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    let mut chars = stem.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let digit = chars.next();
    (prefix == "COM" || prefix == "LPT") && chars.next().is_none() && matches!(digit, Some('0'..='9' | '¹' | '²' | '³'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_what_windows_cannot_name() {
        for bad in [
            "CON", "con", "Nul.md", "aux.txt.bak", "COM1", "lpt9.md", "COM¹", "LPT³.txt", "com0", "CONIN$", "con .md", "a.md:secret", "a<b", "a>b", "a\"b",
            "a|b", "a?b", "a*b", "tab\there", "x.", "x ", "...", "x. ",
        ] {
            assert!(segment_problem(bad).is_some(), "{bad:?}");
        }
        for good in ["CONSOLE.md", "com10", "LPT", "nul-not.md", "Café.md", "บันทึก", ".thoth", "a b.md", "COMa", "contents", "x.y"] {
            assert_eq!(segment_problem(good), None, "{good:?}");
        }
    }
}
