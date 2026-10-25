//! Text from a page, made safe to show (ADR-0020 rule 4): bytes decoded with the page's charset (UTF-8 unless it
//! says Latin-1 or Windows-1252), entities decoded, control and bidirectional-override characters removed, white
//! space collapsed, and cut to a length. The result is shown as text only, never as HTML.

/// Most characters kept of a title, a description and a site name.
pub const MAX_TITLE: usize = 200;
pub const MAX_DESCRIPTION: usize = 300;
pub const MAX_SITE: usize = 80;

/// Decodes a page's bytes. `charset` is the `Content-Type` parameter, if any.
pub fn decode(bytes: &[u8], charset: Option<&str>) -> String {
    let latin = charset.map(|c| c.trim().trim_matches('"').to_ascii_lowercase()).is_some_and(|c| matches!(c.as_str(), "iso-8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" | "us-ascii" | "ascii"));
    if latin {
        // Windows-1252 differs from Latin-1 in 0x80..0x9f only, which become control characters and are removed.
        bytes.iter().map(|b| *b as char).collect()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

const NAMED: &[(&str, &str)] = &[
    ("amp", "&"), ("lt", "<"), ("gt", ">"), ("quot", "\""), ("apos", "'"), ("nbsp", "\u{a0}"), ("ndash", "–"), ("mdash", "—"),
    ("hellip", "…"), ("lsquo", "‘"), ("rsquo", "’"), ("ldquo", "“"), ("rdquo", "”"), ("laquo", "«"), ("raquo", "»"), ("middot", "·"),
    ("bull", "•"), ("copy", "©"), ("reg", "®"), ("trade", "™"), ("deg", "°"), ("times", "×"),
];

/// Decodes HTML character references: numeric ones and a few common names. Anything else is left as written.
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let end = rest[1..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '#')).map(|e| e + 1);
        let decoded = end.filter(|e| rest[*e..].starts_with(';') && *e > 1 && *e <= 32).and_then(|e| {
            let body = &rest[1..e];
            let ch = if let Some(num) = body.strip_prefix('#') {
                let code = if let Some(hex) = num.strip_prefix(['x', 'X']) { u32::from_str_radix(hex, 16).ok() } else { num.parse().ok() };
                code.map(|c| char::from_u32(c).unwrap_or('\u{fffd}').to_string())
            } else {
                NAMED.iter().find(|(n, _)| *n == body).map(|(_, v)| (*v).to_owned())
            };
            ch.map(|c| (c, e + 1))
        });
        match decoded {
            Some((text, used)) => {
                out.push_str(&text);
                rest = &rest[used..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Characters that change how text around them is shown: bidirectional embeddings, overrides and isolates.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// Strips control and bidirectional-override characters, collapses white space, trims, and keeps at most `max`
/// characters. `None` when nothing is left.
pub fn clean(s: &str, max: usize) -> Option<String> {
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if c.is_control() || is_bidi_control(c) || c == '\u{feff}' {
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    if out.is_empty() {
        return None;
    }
    if out.chars().count() > max {
        out = out.chars().take(max).collect::<String>().trim_end().to_owned();
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("a &amp; b &lt;i&gt; &#39;x&#x27; &#8212; &hellip;"), "a & b <i> 'x' — …");
        assert_eq!(decode_entities("&unknown; & &amp &#xZZ; &;"), "&unknown; & &amp &#xZZ; &;");
        assert_eq!(decode_entities("&#0; &#x110000;"), "\u{0} \u{fffd}");
    }

    #[test]
    fn cleans_and_cuts() {
        assert_eq!(clean("  Hello\n\t  world \u{0007}\u{202e}evil\u{202c} ", 200).as_deref(), Some("Hello world evil"));
        assert_eq!(clean("\u{0}\u{1b}[31m red", 200).as_deref(), Some("[31m red"));
        assert_eq!(clean(" \n\t ", 200), None);
        assert_eq!(clean("\u{feff}bom", 200).as_deref(), Some("bom"));
        // Cut by characters, not bytes: Thai and emoji are not split in the middle.
        assert_eq!(clean(&"ก".repeat(250), MAX_TITLE).unwrap().chars().count(), 200);
        assert_eq!(clean(&"😀".repeat(400), MAX_DESCRIPTION).unwrap().chars().count(), 300);
        assert_eq!(clean(&format!("{} tail", "a".repeat(79)), MAX_SITE).as_deref(), Some("a".repeat(79).as_str()));
        // Markup stays text: nothing here removes or interprets it.
        assert_eq!(clean("<img src=x onerror=alert(1)>", 200).as_deref(), Some("<img src=x onerror=alert(1)>"));
    }

    #[test]
    fn decodes_bytes_by_charset() {
        assert_eq!(decode("caf\u{e9}".as_bytes(), None), "café");
        assert_eq!(decode(b"caf\xe9", Some("ISO-8859-1")), "café");
        assert_eq!(decode(b"caf\xe9", Some("utf-8")), "caf\u{fffd}");
    }
}
