//! The app's local log, made safe to show and to send in a problem report (0.3.0): `redact` runs on every line before
//! it reaches `thoth.log`, and `tail` reads the newest lines back for a report, redacting them again. A line keeps
//! what went wrong and where in the code; paths, file and folder names, URL paths and queries, emails, tokens,
//! passwords and other secrets are never kept, only `<path>`, `<email>` or `<redacted>` in their place.
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The longest line, in characters (Unicode scalar values), counting the `…` of a clipped line.
pub const MAX_LINE_CHARS: usize = 500;
/// The most lines `tail` returns.
pub const TAIL_LINES: usize = 200;
/// The most bytes `tail` returns (UTF-8, one newline counted per line).
pub const TAIL_BYTES: usize = 64 * 1024;

/// The words whose value is a secret, any case, `-` read as `_`, also inside a longer name when the key ends it or is
/// followed by `_`, `-` or a capital (`refresh_token`, `Set-Cookie`, `accessToken`, `tokenValue`, `X-Api-Key`, but
/// not `tokens`).
const KEYS: [&str; 9] = ["bearer", "token", "secret", "password", "passwd", "authorization", "cookie", "api_key", "apikey"];
/// Keys whose value, unless quoted, runs to the end of the line (`Authorization: Bearer x`, `Cookie: a=1; b=2`).
const WHOLE_LINE_KEYS: [&str; 2] = ["authorization", "cookie"];
/// A run of this many `[A-Za-z0-9+/=_-]` characters is taken for a token or a key.
const OPAQUE_RUN: usize = 32;

/// One safe log line: control characters become spaces, then a single left-to-right scan replaces URL paths (and
/// URL user info), secrets after a key, paths, emails and long opaque runs; the result is clipped to
/// `MAX_LINE_CHARS`. Over-redacting is the intended failure: anything with a `/` or `\` in it is taken for a path.
pub fn redact(line: &str) -> String {
    let c: Vec<char> = line.chars().map(|ch| if ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}') { ' ' } else { ch }).collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < c.len() {
        if let Some(end) = url(&c, i, &mut out).or_else(|| secret(&c, i, &mut out)) {
            i = end;
        } else if let Some((end, placeholder)) = path(&c, i).map(|e| (e, "<path>")).or_else(|| email(&c, i).map(|e| (e, "<email>"))).or_else(|| opaque(&c, i).map(|e| (e, "<redacted>"))) {
            out.push_str(placeholder);
            i = end;
        } else {
            out.push(c[i]);
            i += 1;
        }
    }
    if out.chars().count() > MAX_LINE_CHARS {
        out = out.chars().take(MAX_LINE_CHARS - 1).chain(['…']).collect();
    }
    out
}

/// Where a token (and so a path) may start: after these, or at the start of the line.
fn is_delim(ch: char) -> bool {
    ch.is_whitespace() || "()[]{}<>\"'`=,;:".contains(ch)
}

/// `scheme://[userinfo@]host[:port]/rest` → `scheme://[<redacted>@]host[:port]/<redacted>`; writes it and returns
/// where the URL ends.
fn url(c: &[char], i: usize, out: &mut String) -> Option<usize> {
    let is_scheme = |ch: char| ch.is_ascii_alphanumeric() || "+.-".contains(ch);
    if !c[i].is_ascii_alphabetic() || i > 0 && is_scheme(c[i - 1]) {
        return None;
    }
    let colon = (i..c.len()).find(|&k| !is_scheme(c[k]))?;
    if c.get(colon..colon + 3)? != [':', '/', '/'] {
        return None;
    }
    let host_start = colon + 3;
    let host_end = (host_start..c.len()).find(|&k| c[k].is_whitespace() || "/?#\"')\\`".contains(c[k])).unwrap_or(c.len());
    let host = &c[host_start..host_end];
    let at = host.iter().rposition(|&ch| ch == '@').map_or(0, |at| at + 1);
    let port = host[at..].iter().rposition(|&ch| ch == ':').map_or(&[][..], |colon| &host[at + colon + 1..]);
    out.extend(&c[i..host_start]);
    if !port.iter().all(char::is_ascii_digit) {
        // `user:pass` cut short by a `/` in the password: not a host.
        out.push_str("<redacted>");
    } else {
        if at > 0 {
            out.push_str("<redacted>@");
        }
        out.extend(&host[at..]);
    }
    let mut depth = 0usize;
    let mut end = host_end;
    while end < c.len() && !c[end].is_whitespace() && !matches!(c[end], '"' | '`') {
        match c[end] {
            '(' => depth += 1,
            ')' if depth == 0 => break,
            ')' => depth -= 1,
            _ => {}
        }
        end += 1;
    }
    if end > host_end {
        out.push_str("/<redacted>");
    }
    Some(end)
}

/// A key from `KEYS`, a separator (`:`, `=` or spaces, after an optional closing quote) and its value; writes the key
/// and separator with `<redacted>` for the value and returns where the value ends. A quoted value runs to its
/// closing quote, any other to the next space (or the end of the line, for `WHOLE_LINE_KEYS`).
fn secret(c: &[char], i: usize, out: &mut String) -> Option<usize> {
    let is_word = |ch: char| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-');
    if !is_word(c[i]) || i > 0 && is_word(c[i - 1]) {
        return None;
    }
    let word_end = (i..c.len()).find(|&k| !is_word(c[k])).unwrap_or(c.len());
    let word = c[i..word_end].iter().collect::<String>().to_ascii_lowercase().replace('-', "_");
    // `is_word` is ASCII only, so byte offsets in `word` are char offsets in `c`.
    let key = KEYS.iter().find(|key| {
        word.match_indices(*key).any(|(at, _)| {
            let after = i + at + key.len();
            after == word_end || matches!(c[after], '_' | '-') || c[after].is_ascii_uppercase()
        })
    })?;
    let mut k = word_end;
    if matches!(c.get(k), Some('"' | '\'')) {
        k += 1;
    }
    let sep = k;
    while c.get(k).is_some_and(|&ch| ch == ':' || ch == '=' || ch.is_whitespace()) {
        k += 1;
    }
    if k == sep {
        return None;
    }
    let quote = c.get(k).copied().filter(|ch| matches!(ch, '"' | '\''));
    if quote.is_some() {
        k += 1;
    }
    let end = if WHOLE_LINE_KEYS.contains(key) && quote.is_none() {
        c.len()
    } else {
        (k..c.len()).find(|&e| quote.map_or(c[e].is_whitespace(), |q| c[e] == q && c[e - 1] != '\\')).unwrap_or(c.len())
    };
    if end == k {
        return None;
    }
    out.extend(&c[i..k]);
    out.push_str("<redacted>");
    Some(end)
}

/// A path: `X:\` or `X:/`, or a token (from a delimiter to the next) holding `/` or `\` that starts with one or holds
/// a letter (`/Users/a`, `~/x`, `./x`, `\\srv\share`, `Notes/x.md`, but not `3/5`). Returns where it ends: a path
/// opened by `'` at the line's last `'`; any other at an unescaped `"`, an unmatched `)`, `": "` or the end of the
/// line, so the spaces, `'` and `(…)` of a name stay inside it.
fn path(c: &[char], i: usize) -> Option<usize> {
    if i > 0 && !is_delim(c[i - 1]) {
        return None;
    }
    let is_sep = |k: usize| matches!(c.get(k), Some('/' | '\\'));
    let token_end = (i..c.len()).find(|&k| is_delim(c[k])).unwrap_or(c.len());
    let drive = c[i].is_ascii_alphabetic() && c.get(i + 1) == Some(&':') && is_sep(i + 2);
    if !drive && (token_end - i < 2 || !(i..token_end).any(is_sep) || !is_sep(i) && !c[i..token_end].iter().any(|ch| ch.is_alphabetic())) {
        return None;
    }
    if i > 0
        && c[i - 1] == '\''
        && let Some(q) = (i..c.len()).rev().find(|&k| c[k] == '\'')
    {
        return Some(q);
    }
    let mut depth = 0usize;
    let mut end = i;
    while end < c.len() {
        match c[end] {
            '"' if c[end - 1] != '\\' => break,
            ':' if c.get(end + 1) == Some(&' ') => break,
            '(' => depth += 1,
            ')' if depth == 0 => break,
            ')' => depth -= 1,
            _ => {}
        }
        end += 1;
    }
    Some(end)
}

/// `local@domain.tld`, where the last label is not all digits (so `pkg@1.2.3` stays). Letters of any script count.
fn email(c: &[char], i: usize) -> Option<usize> {
    let is_local = |ch: char| ch.is_alphanumeric() || "._%+-".contains(ch) || !ch.is_ascii() && !ch.is_whitespace();
    if !is_local(c[i]) || i > 0 && is_local(c[i - 1]) {
        return None;
    }
    let at = (i..c.len()).find(|&k| !is_local(c[k]))?;
    if c[at] != '@' {
        return None;
    }
    let is_domain = |ch: char| ch.is_alphanumeric() || ch == '-' || ch == '.' || !ch.is_ascii() && !ch.is_whitespace();
    let mut end = (at + 1..c.len()).find(|&k| !is_domain(c[k])).unwrap_or(c.len());
    while end > at + 1 && matches!(c[end - 1], '.' | '-') {
        end -= 1;
    }
    let dot = (at + 1..end).rfind(|&k| c[k] == '.')?;
    let tld = &c[dot + 1..end];
    (!tld.is_empty() && !tld.iter().all(char::is_ascii_digit)).then_some(end)
}

/// A run of at least `OPAQUE_RUN` `[A-Za-z0-9+/=_-]` characters.
fn opaque(c: &[char], i: usize) -> Option<usize> {
    let is_opaque = |ch: char| ch.is_ascii_alphanumeric() || "+/=_-".contains(ch);
    if !is_opaque(c[i]) || i > 0 && is_opaque(c[i - 1]) {
        return None;
    }
    let end = (i..c.len()).find(|&k| !is_opaque(c[k])).unwrap_or(c.len());
    (end - i >= OPAQUE_RUN).then_some(end)
}

/// The newest non-blank lines of `thoth.log` and its rotated siblings (`thoth*.log` in `dir`), oldest first, each
/// redacted again: at most `max_lines` lines and `max_bytes` bytes (a newline counted per line), whole lines only.
/// A missing or unreadable folder or file gives fewer lines, never an error.
pub fn tail(dir: &Path, max_lines: usize, max_bytes: usize) -> Vec<String> {
    let mut files: Vec<(SystemTime, bool, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !name.starts_with("thoth") || !name.ends_with(".log") {
                return None;
            }
            // The current file sorts after a rotated one with the same time.
            Some((entry.metadata().ok()?.modified().ok()?, name == "thoth.log", entry.path()))
        })
        .collect();
    files.sort();
    let mut lines = Vec::new();
    let mut bytes = 0;
    'files: for (_, _, file) in files.iter().rev() {
        let Ok(raw) = std::fs::read(file) else { continue };
        for line in String::from_utf8_lossy(&raw).lines().rev() {
            let line = redact(line);
            if line.trim().is_empty() {
                continue;
            }
            if lines.len() >= max_lines || bytes + line.len() + 1 > max_bytes {
                break 'files;
            }
            bytes += line.len() + 1;
            lines.push(line);
        }
    }
    lines.reverse();
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::{Duration, SystemTime};

    #[test]
    fn redacts_unix_path_with_spaces() {
        assert_eq!(redact("failed to open /Users/a/My Notes/Secret plan.md: denied"), "failed to open <path>: denied");
        assert_eq!(redact("read \"/Users/a/x.md\" failed"), "read \"<path>\" failed");
        assert_eq!(redact("open /Users/a/Plan (secret) v2.md"), "open <path>");
        assert_eq!(redact("open('/Users/a/Bob's plan.md')"), "open('<path>')");
        assert_eq!(redact("path=/x/y.md done"), "path=<path>");
        assert_eq!(redact("1 / 2 = 3/6"), "1 / 2 = 3/6");
        // Vault-relative paths are what the host handles most; `and/or` is the price.
        assert_eq!(redact("moved Notes/Secret plan.md: ok"), "moved <path>: ok");
    }

    #[test]
    fn redacts_windows_and_unc_paths() {
        assert_eq!(redact(r"C:\Users\a\Notes\x.md"), "<path>");
        assert_eq!(redact(r"\\srv\share\x.md"), "<path>");
        assert_eq!(redact(r"open C:/Users/a/My Notes/x.md: Access is denied"), "open <path>: Access is denied");
    }

    #[test]
    fn redacts_home_tilde() {
        assert_eq!(redact("~/Notes/x.md"), "<path>");
        assert_eq!(redact("at ./Notes/x.md and ../y.md"), "at <path>");
    }

    #[test]
    fn keeps_only_url_host() {
        assert_eq!(redact("https://api.thothnotes.com/s/AbC123xyz?x=1"), "https://api.thothnotes.com/<redacted>");
        assert_eq!(redact("https://thothnotes.com"), "https://thothnotes.com");
        assert_eq!(redact("(see https://thothnotes.com)"), "(see https://thothnotes.com)");
        assert_eq!(redact("GET https://thothnotes.com/?invite=x 404"), "GET https://thothnotes.com/<redacted> 404");
        assert_eq!(redact("postgres://me:p,w@db.local:5432/thoth"), "postgres://<redacted>@db.local:5432/<redacted>");
        assert_eq!(redact("file:///Users/a/x.md"), "file:///<redacted>");
    }

    #[test]
    fn redacts_email() {
        assert_eq!(redact("mail a.b@c.co now"), "mail <email> now");
        assert_eq!(redact("<ผู้ใช้@ตัวอย่าง.ไทย>"), "<<email>>");
    }

    #[test]
    fn redacts_secrets_after_keys() {
        assert_eq!(redact("Bearer abc.def"), "Bearer <redacted>");
        assert_eq!(redact("token=abc"), "token=<redacted>");
        assert_eq!(redact("password: x"), "password: <redacted>");
        assert_eq!(redact("Authorization: abc"), "Authorization: <redacted>");
        assert_eq!(redact("AUTHORIZATION: Bearer abc"), "AUTHORIZATION: <redacted>");
        assert_eq!(redact("authorization: Basic dXNlcjpw"), "authorization: <redacted>");
        assert_eq!(redact("send bearer abc then"), "send bearer <redacted> then");
        assert_eq!(redact("PassWord=hunter2 ok"), "PassWord=<redacted> ok");
        assert_eq!(redact("refresh_token=r1 x-api-key"), "refresh_token=<redacted> x-api-key");
        assert_eq!(redact("authToken=a tokenValue=b X-Api-Key: c"), "authToken=<redacted> tokenValue=<redacted> X-Api-Key: <redacted>");
        assert_eq!(redact(r#"{"api_key":"k1","n":1}"#), r#"{"api_key":"<redacted>","n":1}"#);
        assert_eq!(redact("Cookie: a=1; session=xyz"), "Cookie: <redacted>");
        assert_eq!(redact("authorization=Bearer abc"), "authorization=<redacted>");
        assert_eq!(redact(r#"{"authorization":"Bearer abc","n":1}"#), r#"{"authorization":"<redacted>","n":1}"#);
        assert_eq!(redact("password=token"), "password=<redacted>");
        assert_eq!(redact("tokens left: 3"), "tokens left: 3");
    }

    #[test]
    fn redacts_long_opaque_runs() {
        let run = "aB3+=_-9".repeat(4);
        assert_eq!(redact(&format!("id {run} end")), "id <redacted> end");
        assert_eq!(redact(&format!("id {} end", &run[..31])), format!("id {} end", &run[..31]));
        // With a `/` in it the run is taken for a path, which hides it too (to the end of the line).
        assert_eq!(redact(&format!("id {} end", "aB3+/=_-".repeat(4))), "id <path>");
        assert_eq!(redact("x.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.y"), "x.<redacted>.y");
    }

    #[test]
    fn redaction_is_stable_when_run_again() {
        for line in [
            "failed to open /Users/a/My Notes/Secret plan.md: denied",
            "https://api.thothnotes.com/s/AbC123xyz?x=1",
            "postgres://me:pw@db.local/thoth",
            "mail a.b@c.co now",
            "Authorization: Bearer abc",
            &"ก".repeat(600),
        ] {
            let once = redact(line);
            assert_eq!(redact(&once), once, "{line}");
        }
    }

    #[test]
    fn flattens_and_clips_on_char_boundary() {
        assert_eq!(redact("a\tb\nc\r\u{0}d\u{2028}e"), "a b c  d e");
        let long = format!("{}😀", "ก".repeat(600));
        let out = redact(&long);
        assert_eq!(out.chars().count(), MAX_LINE_CHARS);
        assert!(out.ends_with('…'));
        assert!(out.starts_with('ก'));
        assert_eq!(redact(&"ก".repeat(MAX_LINE_CHARS)), "ก".repeat(MAX_LINE_CHARS));
    }

    fn write(dir: &Path, name: &str, lines: impl Iterator<Item = String>, age_secs: u64) {
        let text: String = lines.map(|l| l + "\n").collect();
        std::fs::write(dir.join(name), text).unwrap();
        let file = File::options().write(true).open(dir.join(name)).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(age_secs)).unwrap();
    }

    #[test]
    fn tail_reads_rotated_files_newest_last() {
        let dir = tempfile::tempdir().unwrap();
        // Names sort the other way round from their times: the order must come from the times.
        write(dir.path(), "thoth_2026-10-30_09-00-00.log", (0..100).map(|i| format!("line {i:03}")), 300);
        write(dir.path(), "thoth_2026-10-30_08-00-00.log", (100..200).map(|i| format!("line {i:03}")), 200);
        write(dir.path(), "thoth.log", (200..300).map(|i| format!("line {i:03}")), 100);
        write(dir.path(), "other.log", (0..10).map(|i| format!("other {i}")), 0);
        let lines = tail(dir.path(), TAIL_LINES, TAIL_BYTES);
        let want: Vec<String> = (100..300).map(|i| format!("line {i:03}")).collect();
        assert_eq!(lines, want);

        // Long lines: the byte budget cuts in first, and only whole lines are kept.
        let long = |i: usize| format!("line {i:03} {}", "lorem ipsum ".repeat(33));
        write(dir.path(), "thoth.log", (100..300).map(long), 100);
        let lines = tail(dir.path(), TAIL_LINES, TAIL_BYTES);
        assert!(lines.len() < TAIL_LINES);
        assert!(lines.iter().map(|l| l.len() + 1).sum::<usize>() <= TAIL_BYTES);
        assert_eq!(lines.last().unwrap(), &long(299));
        assert!(lines.iter().all(|l| l.ends_with("ipsum ")));
        assert_eq!(lines.first().unwrap(), &long(300 - lines.len()));
    }

    #[test]
    fn tail_of_missing_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(tail(&dir.path().join("missing"), TAIL_LINES, TAIL_BYTES).is_empty());
    }

    #[test]
    fn tail_skips_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("thoth.log"), "a\n\n   \n\u{1}\r\nb token=s3\n").unwrap();
        assert_eq!(tail(dir.path(), TAIL_LINES, TAIL_BYTES), ["a", "b token=<redacted>"]);
    }
}
