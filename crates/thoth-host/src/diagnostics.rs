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
/// where the URL ends. User info runs to the last `@` before a `/`, `?`, `#`, quote or space. The host ends at the first
/// character a host cannot hold, and anything after it that is not a path, query or fragment goes back to the scan
/// (`https://h,token=x`). A `file:` URL's path ends like a plain path.
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
    // User info is everything up to the last `@` before the path, whatever characters the password holds.
    let authority_end = (host_start..c.len()).find(|&k| c[k].is_whitespace() || "/?#\"'`".contains(c[k])).unwrap_or(c.len());
    let user_info_end = (host_start..authority_end).rfind(|&k| c[k] == '@');
    let host_start = user_info_end.map_or(host_start, |at| at + 1);
    // Letters, digits, `.-`, `[]:` (IPv6, port) and `%`.
    let is_host = |ch: char| ch.is_alphanumeric() || ".-[]:%".contains(ch);
    let host_end = (host_start..c.len()).find(|&k| !is_host(c[k])).unwrap_or(c.len());
    let host = &c[host_start..host_end];
    let after_ipv6 = host.iter().rposition(|&ch| ch == ']').map_or(0, |b| b + 1);
    let port = host[after_ipv6..].iter().rposition(|&ch| ch == ':').map_or(&[][..], |colon| &host[after_ipv6 + colon + 1..]);
    out.extend(&c[i..colon + 3]);
    if user_info_end.is_some() {
        out.push_str("<redacted>@");
    }
    if !port.iter().all(char::is_ascii_digit) {
        // `user:pass` cut short by a `/` in the password: not a host.
        out.push_str("<redacted>");
    } else {
        out.extend(host);
    }
    if !matches!(c.get(host_end), Some('/' | '\\' | '?' | '#')) {
        return Some(host_end);
    }
    let scheme = c[i..colon].iter().collect::<String>().to_ascii_lowercase();
    if scheme == "file" {
        out.push_str("/<redacted>");
        return Some(path_end(c, host_end, false));
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
    let host = host.iter().collect::<String>().to_ascii_lowercase();
    let own = user_info_end.is_none() && matches!((scheme.as_str(), host.as_str()), ("tauri", "localhost") | ("http" | "https", "tauri.localhost"));
    if !(own && app_location(&c[host_end..end], out)) {
        out.push_str("/<redacted>");
    }
    Some(end)
}

/// The rest of a URL on the app's own origin (its bundled scripts, in a webview stack): keeps the path and a trailing
/// `:line:col`, and replaces a query or fragment with `<redacted>`. `false`, writing nothing, when the path holds
/// anything but `[A-Za-z0-9._/-]`, so the caller falls back to the usual rule.
fn app_location(rest: &[char], out: &mut String) -> bool {
    let mut loc = rest.len();
    for _ in 0..2 {
        let digits = rest[..loc].iter().rev().take_while(|ch| ch.is_ascii_digit()).count();
        if digits == 0 || loc < digits + 1 || rest[loc - digits - 1] != ':' {
            break;
        }
        loc -= digits + 1;
    }
    let path_len = rest[..loc].iter().position(|&ch| matches!(ch, '?' | '#')).unwrap_or(loc);
    let path = &rest[..path_len];
    if path.first().is_some_and(|&ch| ch != '/') || !path.iter().all(|&ch| ch.is_ascii_alphanumeric() || "._/-".contains(ch)) {
        return false;
    }
    out.extend(path);
    if path_len < loc {
        out.push(rest[path_len]);
        out.push_str("<redacted>");
    }
    out.extend(&rest[loc..]);
    true
}

/// A key from `KEYS`, a separator (`:`, `=` or spaces, after an optional closing quote) and its value; writes the key
/// and separator with `<redacted>` for the value and returns where the value ends. A quoted value runs to its
/// closing quote, one that opens with `Some(`, `(`, `[` or `{` (Rust's `Debug`) to its matching bracket, any other to
/// the next space (or the end of the line, for `WHOLE_LINE_KEYS`).
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
    const REDACTED: [char; 10] = ['<', 'r', 'e', 'd', 'a', 'c', 't', 'e', 'd', '>'];
    let bracket = if c[k..].starts_with(&['S', 'o', 'm', 'e', '(']) { Some(k + 4) } else { Some(k).filter(|_| matches!(c.get(k), Some('(' | '[' | '{'))) };
    let end = if c[k..].starts_with(&REDACTED) {
        // Already redacted (by `tail`'s second pass): keep what follows, such as the `,` after a `Debug` value.
        k + REDACTED.len()
    } else if let Some(q) = quote {
        (k..c.len()).find(|&e| c[e] == q && c[e - 1] != '\\').unwrap_or(c.len())
    } else if let Some(open) = bracket {
        bracket_end(c, open)
    } else if WHOLE_LINE_KEYS.contains(key) {
        c.len()
    } else {
        (k..c.len()).find(|&e| c[e].is_whitespace()).unwrap_or(c.len())
    };
    if end == k {
        return None;
    }
    out.extend(&c[i..k]);
    out.push_str("<redacted>");
    Some(end)
}

/// Just past the bracket that closes the one at `open` (brackets inside `"…"` do not count), or the end of the line.
fn bracket_end(c: &[char], open: usize) -> usize {
    let mut depth = 0usize;
    let mut in_string = false;
    for e in open..c.len() {
        match c[e] {
            '"' if in_string && c[e - 1] != '\\' => in_string = false,
            _ if in_string => {}
            '"' => in_string = true,
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return e + 1;
                }
            }
            _ => {}
        }
    }
    c.len()
}

/// A path: `X:\` or `X:/`, or a token (from a delimiter to the next) holding `/` or `\` that starts with one or holds
/// a letter (`/Users/a`, `~/x`, `./x`, `\\srv\share`, `Notes/x.md`, but not `3/5`). Kept: a relative source location
/// under a `src` folder (`src/lib.rs:42:5`, `crates/x/src/y.rs:3:1`, from panics) and `HTTP/1.1`. Returns where it ends: a path opened by `'` at the line's last
/// `'`; any other as `path_end` says, so the spaces, `'` and `(…)` of a name stay inside it.
fn path(c: &[char], i: usize) -> Option<usize> {
    if i > 0 && !is_delim(c[i - 1]) {
        return None;
    }
    let token = &c[i..(i..c.len()).find(|&k| is_delim(c[k])).unwrap_or(c.len())];
    let after = c.get(i + token.len()..).unwrap_or_default();
    let starts_with_sep = matches!(c[i], '/' | '\\');
    let drive = c[i].is_ascii_alphabetic() && matches!(c.get(i + 1..i + 3), Some([':', '/' | '\\']));
    let has_sep = token.iter().any(|&ch| matches!(ch, '/' | '\\'));
    let has_letter = token.iter().any(|ch| ch.is_alphabetic());
    let looks_like_path = drive || token.len() >= 2 && has_sep && (starts_with_sep || has_letter);
    let relative = !starts_with_sep && !drive && c[i] != '~';
    let in_src = token.split(|&ch| matches!(ch, '/' | '\\')).any(|segment| segment == ['s', 'r', 'c']);
    let source_location = relative && in_src && token.ends_with(&['.', 'r', 's']) && matches!(after, [':', d, ..] if d.is_ascii_digit());
    let token_text: String = token.iter().collect();
    let http_version = token_text.get(..5).is_some_and(|h| h.eq_ignore_ascii_case("http/")) && token_text[5..].chars().all(|ch| ch.is_ascii_digit() || ch == '.');
    if !looks_like_path || source_location || http_version {
        return None;
    }
    let opener = (i > 0).then(|| c[i - 1]);
    if opener == Some('\'')
        && let Some(q) = (i..c.len()).rev().find(|&k| c[k] == '\'')
    {
        return Some(q);
    }
    Some(path_end(c, i, opener == Some('[')))
}

/// Where a path from `from` ends: at an unescaped `"`, at `": "`, at an unmatched `)` (or `]`, for a path `[` opened)
/// or at the end of the line.
fn path_end(c: &[char], from: usize, in_square: bool) -> usize {
    let (mut round, mut square) = (0usize, 0usize);
    let mut end = from;
    while end < c.len() {
        match c[end] {
            '"' if end == 0 || c[end - 1] != '\\' => break,
            ':' if c.get(end + 1) == Some(&' ') => break,
            '(' => round += 1,
            ')' if round == 0 => break,
            ')' => round -= 1,
            '[' if in_square => square += 1,
            ']' if in_square && square == 0 => break,
            ']' if in_square => square -= 1,
            _ => {}
        }
        end += 1;
    }
    end
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
        // shortcut: reads whole files, relies on 1 MB rotation; read only the tail if rotation ever changes.
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
        assert_eq!(redact("postgres://me:pw@db.local:5432/thoth"), "postgres://<redacted>@db.local:5432/<redacted>");
        assert_eq!(redact("postgres://me:p,w@db.local:5432/thoth"), "postgres://<redacted>@db.local:5432/<redacted>");
        assert_eq!(redact("http://[::1]:8080/x http://[::1]/y"), "http://[::1]:8080/<redacted> http://[::1]/<redacted>");
        assert_eq!(redact("file:///Users/a/x.md"), "file:///<redacted>");
    }

    #[test]
    fn keeps_webview_stack_locations_on_the_apps_own_origin_only() {
        assert_eq!(redact("foo@tauri://localhost/assets/index-abc.js:12:345"), "foo@tauri://localhost/assets/index-abc.js:12:345");
        assert_eq!(redact("at f (http://tauri.localhost/assets/x.js:1:2)"), "at f (http://tauri.localhost/assets/x.js:1:2)");
        assert_eq!(redact("https://tauri.localhost/assets/x.js:1:2"), "https://tauri.localhost/assets/x.js:1:2");
        // The host must match exactly: a look-alike, a port or user info gets the usual rule.
        assert_eq!(redact("https://tauri.localhost.evil.com/a/b"), "https://tauri.localhost.evil.com/<redacted>");
        assert_eq!(redact("http://evil.tauri.localhost/a/b"), "http://evil.tauri.localhost/<redacted>");
        assert_eq!(redact("tauri://localhost:9/a/b"), "tauri://localhost:9/<redacted>");
        assert_eq!(redact("tauri://me@localhost/a/b"), "tauri://<redacted>@localhost/<redacted>");
        assert_eq!(redact("https://localhost/a/b"), "https://localhost/<redacted>");
        // Only the path and `:line:col` are kept; a query or fragment is not.
        assert_eq!(redact("tauri://localhost/x?token=abc"), "tauri://localhost/x?<redacted>");
        assert_eq!(redact("tauri://localhost/x.js?v=1:3:4"), "tauri://localhost/x.js?<redacted>:3:4");
        assert_eq!(redact("tauri://localhost/x#My Notes"), "tauri://localhost/x#<redacted> Notes");
        // A path the app would not serve (an email, a space-free name with other characters) gets the usual rule.
        assert_eq!(redact("tauri://localhost/a@b.co/x"), "tauri://localhost/<redacted>");
    }

    #[test]
    fn url_host_ends_where_a_host_cannot_go_on() {
        assert_eq!(redact("url=https://api.x.com,token=abc123"), "url=https://api.x.com,token=<redacted>");
        assert_eq!(redact("https://h;password=x"), "https://h;password=<redacted>");
        // An `@` before the path makes all before it user info (round 2 ruling): `me` is hidden either way.
        assert_eq!(redact("https://h,me@x.com"), "https://<redacted>@x.com");
        assert_eq!(redact("https://h,see me@x.com"), "https://h,see <email>");
    }

    #[test]
    fn url_user_info_is_hidden_whatever_the_password_holds() {
        assert_eq!(redact("postgres://me:pa$s@h/x"), "postgres://<redacted>@h/<redacted>");
        assert_eq!(redact("redis://:p_w~x@h:6379"), "redis://<redacted>@h:6379");
        assert_eq!(redact("amqp://u:abc|def@h/v"), "amqp://<redacted>@h/<redacted>");
        assert_eq!(redact("postgres://me:pa!ss@db.local:5432/thoth"), "postgres://<redacted>@db.local:5432/<redacted>");
        assert_eq!(redact("postgres://me:pa&ss=1@h/x"), "postgres://<redacted>@h/<redacted>");
        assert_eq!(redact("postgres://me:p@ss@h/x"), "postgres://<redacted>@h/<redacted>");
    }

    #[test]
    fn file_url_path_ends_like_a_path() {
        assert_eq!(redact("file:///Users/a/My Big plan.md"), "file:///<redacted>");
        assert_eq!(redact("open file:///Users/a/My Big plan.md: denied"), "open file:///<redacted>: denied");
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
    fn redacts_debug_values_to_their_closing_bracket() {
        assert_eq!(redact("token: Some(\n        \"abc\",\n    ),"), "token: <redacted>,");
        assert_eq!(redact(r#"password: Some("a b")"#), "password: <redacted>");
        assert_eq!(redact(r#"Login { password: Some("a ) b"), user: 1 }"#), "Login { password: <redacted>, user: 1 }");
        assert_eq!(redact("secret: [1, 2, 3] next"), "secret: <redacted> next");
        assert_eq!(redact("secret: (1, 2"), "secret: <redacted>");
    }

    #[test]
    fn keeps_code_locations_and_protocol_tokens() {
        assert_eq!(redact("panicked at src/lib.rs:42:5: boom"), "panicked at src/lib.rs:42:5: boom");
        assert_eq!(redact(r"panicked at crates\thoth-host\src\sql.rs:7: boom"), r"panicked at crates\thoth-host\src\sql.rs:7: boom");
        assert_eq!(redact("panicked at /Users/a/src/lib.rs:42:5: boom"), "panicked at <path>: boom");
        assert_eq!(redact("panicked at crates/x/src/y.rs:3:1: boom"), "panicked at crates/x/src/y.rs:3:1: boom");
        assert_eq!(redact("open Notes/plan.rs now"), "open <path>");
        for outside_src in ["Notes/secret.rs:1", "./Secret/x.rs:3", "../Secret/x.rs:3"] {
            assert_eq!(redact(&format!("at {outside_src} x")), "at <path>", "{outside_src}");
        }
        assert_eq!(redact("response HTTP/1.1 503 Service Unavailable"), "response HTTP/1.1 503 Service Unavailable");
        assert_eq!(redact("[/Users/a/x.md] y"), "[<path>] y");
        assert_eq!(redact("[/Users/a/[draft] x.md] y"), "[<path>] y");
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
            "postgres://me:pa!ss@db.local:5432/thoth",
            "redis://:p_w~x@h:6379",
            "file:///Users/a/My Big plan.md",
            "foo@tauri://localhost/assets/index-abc.js:12:345",
            "at f (http://tauri.localhost/assets/x.js:1:2)",
            "tauri://localhost/x?token=abc",
            "tauri://localhost/x.js?v=1:3:4#y",
            "https://tauri.localhost.evil.com/a/b",
            "panicked at src/lib.rs:42:5: boom",
            "[/Users/a/x.md] y",
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
    fn tail_keeps_the_other_lines_of_a_file_with_bad_utf8() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("thoth.log"), b"a\n\xff\xfe bad\nb\n").unwrap();
        assert_eq!(tail(dir.path(), TAIL_LINES, TAIL_BYTES), ["a", "\u{FFFD}\u{FFFD} bad", "b"]);
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
