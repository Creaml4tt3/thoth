//! Reads a page's preview from the start of its HTML (ADR-0020 rule 4): `og:title`, `og:description`,
//! `og:site_name` and `og:image`, with `twitter:` fallbacks and `<title>`. Only `<meta>` tags and `<title>` in the head
//! are read; comments, `<script>` and `<style>` are skipped, and reading stops at `</head>` or `<body>`. The values are
//! untrusted text: entities are decoded here, and `text::clean` strips and cuts them; nothing is ever HTML again.
use super::text::decode_entities;

/// What the head of a page says about itself. Raw (decoded, not yet cleaned) values; `None` when absent.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Head {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image: Option<String>,
}

#[derive(Default)]
struct Found {
    og_title: Option<String>,
    og_description: Option<String>,
    og_site: Option<String>,
    og_image: Option<String>,
    tw_title: Option<String>,
    tw_description: Option<String>,
    tw_image: Option<String>,
    title: Option<String>,
}

fn set(slot: &mut Option<String>, value: &str) {
    if slot.is_none() && !value.trim().is_empty() {
        *slot = Some(value.to_owned());
    }
}

/// Byte offset of the first case-insensitive `needle` (ASCII) in `hay` at or after `from`.
fn find_ci(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from >= hay.len() || needle.len() > hay.len() - from {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()].eq_ignore_ascii_case(needle))
}

/// Does a tag named `name` (ASCII, lower case) start at `i` (just after `<`)?
fn tag_is(html: &[u8], i: usize, name: &[u8]) -> bool {
    html.len() >= i + name.len()
        && html[i..i + name.len()].eq_ignore_ascii_case(name)
        && html.get(i + name.len()).is_none_or(|c| c.is_ascii_whitespace() || *c == b'>' || *c == b'/')
}

/// The attributes of the tag whose name ends at `i`, and the offset just after its `>`.
fn attributes(html: &str, mut i: usize) -> (Vec<(String, String)>, usize) {
    let b = html.as_bytes();
    let mut out = Vec::new();
    loop {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        if i >= b.len() {
            return (out, i);
        }
        if b[i] == b'>' {
            return (out, i + 1);
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        let name = html[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let quote = b[i];
                let end = b[i + 1..].iter().position(|c| *c == quote).map_or(b.len(), |p| i + 1 + p);
                value = html[i + 1..end].to_owned();
                i = (end + 1).min(b.len());
            } else {
                let start = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                    i += 1;
                }
                value = html[start..i].to_owned();
            }
        }
        if !name.is_empty() {
            out.push((name, decode_entities(&value)));
        }
    }
}

/// Reads the head of `html` (already decoded to text).
pub fn read_head(html: &str) -> Head {
    let b = html.as_bytes();
    let mut found = Found::default();
    let mut i = 0;
    while let Some(lt) = b[i..].iter().position(|c| *c == b'<').map(|p| i + p) {
        let at = lt + 1;
        if b[at..].starts_with(b"!--") {
            i = find_ci(b, at + 3, b"-->").map_or(b.len(), |e| e + 3);
        } else if tag_is(b, at, b"script") || tag_is(b, at, b"style") || tag_is(b, at, b"noscript") || tag_is(b, at, b"template") {
            let name: &[u8] = if tag_is(b, at, b"script") {
                b"</script"
            } else if tag_is(b, at, b"style") {
                b"</style"
            } else if tag_is(b, at, b"noscript") {
                b"</noscript"
            } else {
                b"</template"
            };
            i = find_ci(b, at, name).map_or(b.len(), |e| e + name.len());
        } else if tag_is(b, at, b"/head") || tag_is(b, at, b"body") {
            break;
        } else if tag_is(b, at, b"meta") {
            let (attrs, next) = attributes(html, at + 4);
            i = next;
            let get = |n: &str| attrs.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str());
            let (Some(key), Some(content)) = (get("property").or_else(|| get("name")), get("content")) else { continue };
            match key.trim().to_ascii_lowercase().as_str() {
                "og:title" => set(&mut found.og_title, content),
                "og:description" => set(&mut found.og_description, content),
                "og:site_name" => set(&mut found.og_site, content),
                "og:image" | "og:image:url" | "og:image:secure_url" => set(&mut found.og_image, content),
                "twitter:title" => set(&mut found.tw_title, content),
                "twitter:description" => set(&mut found.tw_description, content),
                "twitter:image" | "twitter:image:src" => set(&mut found.tw_image, content),
                _ => {}
            }
        } else if tag_is(b, at, b"title") {
            let (_, start) = attributes(html, at + 5);
            let end = find_ci(b, start, b"</title").unwrap_or(b.len());
            if found.title.is_none() {
                set(&mut found.title, &decode_entities(&html[start..end]));
            }
            i = end;
        } else {
            i = at;
        }
        if i >= b.len() {
            break;
        }
    }
    Head {
        title: found.og_title.or(found.tw_title).or(found.title),
        description: found.og_description.or(found.tw_description),
        site_name: found.og_site,
        image: found.og_image.or(found.tw_image),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_open_graph() {
        let head = read_head(
            r#"<!doctype html><html><head><meta charset="utf-8">
            <title>Fallback title</title>
            <meta property="og:title" content="The &amp; title">
            <meta property='og:description' content='Two &lt;lines&gt; &#8211; here'>
            <meta property=og:site_name content=Example>
            <meta content="/img.png" property="og:image" />
            </head><body><meta property="og:title" content="in the body"></body></html>"#,
        );
        assert_eq!(head, Head { title: Some("The & title".into()), description: Some("Two <lines> – here".into()), site_name: Some("Example".into()), image: Some("/img.png".into()) });
    }

    #[test]
    fn falls_back_to_twitter_then_title() {
        let head = read_head(r#"<head><TITLE>Plain &quot;title&quot;</TITLE><meta name="twitter:description" content="Tw desc"><meta name="twitter:image:src" content="https://x.example/t.jpg"></head>"#);
        assert_eq!(head, Head { title: Some("Plain \"title\"".into()), description: Some("Tw desc".into()), site_name: None, image: Some("https://x.example/t.jpg".into()) });
        let head = read_head(r#"<head><title>T</title><meta name="twitter:title" content="Tw"></head>"#);
        assert_eq!(head.title.as_deref(), Some("Tw"));
        assert_eq!(read_head("<head><meta property=\"og:title\" content=\"\"><title>Kept</title></head>").title.as_deref(), Some("Kept"));
    }

    #[test]
    fn skips_comments_scripts_and_styles_and_stops_at_the_body() {
        let head = read_head(
            r#"<head><!-- <meta property="og:title" content="comment"> -->
            <script>var s = '<meta property="og:title" content="script">';</script>
            <style>/* <meta property="og:title" content="style"> */</style>
            <meta property="og:title" content="real"></head>
            <body><meta property="og:description" content="body"></body>"#,
        );
        assert_eq!(head.title.as_deref(), Some("real"));
        assert_eq!(head.description, None);
        assert_eq!(read_head("<body><title>late</title>").title, None);
    }

    #[test]
    fn survives_broken_markup() {
        for html in ["<", "<meta", "<meta property=\"og:title\" content=\"x", "<title>no end", "<!-- no end", "<script>no end", "<meta =x>", "<<<>>>", "<meta property=og:title content=>", "\u{0}<\u{1}meta"] {
            let _ = read_head(html);
        }
        assert_eq!(read_head("<title>no end").title.as_deref(), Some("no end"));
    }
}
