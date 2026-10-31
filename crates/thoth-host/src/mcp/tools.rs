//! The four read-only tools of Connected apps (ADR-0021 rule 3): what a request may ask, checked here at the trust
//! boundary (the socket), and the answer built from what the windows' vaults found.
//!
//! The webview runs the queries on its open `Vault`; the host decides which Private Spaces are asked, cuts every list
//! to its limit and builds the answer from the fields it knows, so nothing else a window sends reaches an app.
use crate::error::{HostError, HostResult};
use serde_json::{Map, Value, json};

/// Longest search text, in characters.
const MAX_QUERY: usize = 500;
/// Longest page path or folder, in bytes (a vault path is much shorter in practice).
const MAX_PATH: usize = 1024;
const MAX_ID: usize = 128;
const MAX_SPACE: usize = 256;
pub const SEARCH_LIMIT: Limit = Limit { default: 10, max: 50 };
pub const LIST_LIMIT: Limit = Limit { default: 200, max: 500 };
pub const BACKLINK_LIMIT: Limit = Limit { default: 50, max: 200 };
/// The most page paths one log entry keeps.
pub const LOGGED_PATHS: usize = 50;

#[derive(Clone, Copy, Debug)]
pub struct Limit {
    pub default: u64,
    pub max: u64,
}

/// A page named by its vault path or its stable id (ADR-0003).
#[derive(Clone, Debug, PartialEq)]
pub enum PageRef {
    Path(String),
    Id(String),
}

/// One checked tool call.
#[derive(Clone, Debug, PartialEq)]
pub enum Call {
    Search { query: String, limit: u64, space: Option<String> },
    ListPages { folder: String, limit: u64, space: Option<String> },
    ReadPage { page: PageRef, space: Option<String> },
    Backlinks { page: PageRef, limit: u64, space: Option<String> },
}

pub const TOOLS: &[&str] = &["search", "list_pages", "read_page", "backlinks"];

impl Call {
    /// Checks `arguments` for `tool`. Unknown keys are ignored; a wrong type, an empty search or an unsafe path is
    /// `BAD_ARGUMENT`. Limits above the maximum are cut to it.
    pub fn parse(tool: &str, arguments: &Value) -> HostResult<Self> {
        let args = arguments.as_object().ok_or_else(|| HostError::bad_argument("arguments must be an object"))?;
        let space = optional_text(args, "space", MAX_SPACE)?;
        match tool {
            "search" => {
                let query = optional_text(args, "query", MAX_QUERY * 4)?.map(|q| q.trim().to_owned()).unwrap_or_default();
                if query.is_empty() {
                    return Err(HostError::bad_argument("query must be some text to search for"));
                }
                if query.chars().count() > MAX_QUERY {
                    return Err(HostError::bad_argument(format!("query is longer than {MAX_QUERY} characters")));
                }
                Ok(Call::Search { query, limit: limit(args, SEARCH_LIMIT)?, space })
            }
            "list_pages" => {
                let folder = optional_text(args, "folder", MAX_PATH)?.map(|f| folder(&f)).transpose()?.unwrap_or_default();
                Ok(Call::ListPages { folder, limit: limit(args, LIST_LIMIT)?, space })
            }
            "read_page" => Ok(Call::ReadPage { page: page_ref(args)?, space }),
            "backlinks" => Ok(Call::Backlinks { page: page_ref(args)?, limit: limit(args, BACKLINK_LIMIT)?, space }),
            _ => Err(HostError::bad_argument(format!("Unknown tool {tool:?}"))),
        }
    }

    pub fn tool(&self) -> &'static str {
        match self {
            Call::Search { .. } => "search",
            Call::ListPages { .. } => "list_pages",
            Call::ReadPage { .. } => "read_page",
            Call::Backlinks { .. } => "backlinks",
        }
    }

    pub fn space(&self) -> Option<&str> {
        match self {
            Call::Search { space, .. } | Call::ListPages { space, .. } | Call::ReadPage { space, .. } | Call::Backlinks { space, .. } => space.as_deref(),
        }
    }

    /// Search and the page list look in every shared Private Space; one page is read from one.
    pub fn one_space(&self) -> bool {
        matches!(self, Call::ReadPage { .. } | Call::Backlinks { .. })
    }

    /// What a window is asked (`mcp.request`'s `args`): the checked values only.
    pub fn window_args(&self) -> Value {
        let page = |page: &PageRef| match page {
            PageRef::Path(path) => json!({ "path": path }),
            PageRef::Id(id) => json!({ "id": id }),
        };
        match self {
            Call::Search { query, limit, .. } => json!({ "query": query, "limit": limit }),
            Call::ListPages { folder, limit, .. } => json!({ "folder": folder, "limit": limit }),
            Call::ReadPage { page: p, .. } => page(p),
            Call::Backlinks { page: p, limit, .. } => {
                let mut args = page(p);
                args["limit"] = json!(limit);
                args
            }
        }
    }

    /// The paths a log entry keeps for this call when it fails (when it succeeds, `Answer::paths`).
    pub fn asked_paths(&self) -> Vec<String> {
        match self {
            Call::ListPages { folder, .. } => vec![format!("{folder}/")],
            Call::ReadPage { page: PageRef::Path(path), .. } | Call::Backlinks { page: PageRef::Path(path), .. } => vec![path.clone()],
            _ => Vec::new(),
        }
    }
}

/// A finished answer: `text` for the model, `structured` for the app (`structuredContent`), and the page paths it
/// named, for the log.
#[derive(Debug)]
pub struct Answer {
    pub text: String,
    pub structured: Value,
    pub paths: Vec<String>,
}

/// One window's answer for one Private Space.
pub struct Found<'a> {
    pub space: &'a str,
    pub value: &'a Value,
}

/// Builds the answer from the windows' answers, in the order the Private Spaces were asked.
pub fn answer(call: &Call, found: &[Found<'_>]) -> HostResult<Answer> {
    match call {
        Call::Search { limit, .. } => {
            let mut results = Vec::new();
            for f in found {
                for hit in list(f.value, "hits")? {
                    results.push(json!({ "space": f.space, "path": text(hit, "path")?, "title": text(hit, "title")?, "id": text(hit, "id")?, "snippet": text(hit, "snippet")? }));
                }
            }
            results.truncate(*limit as usize);
            let paths = paths_of(&results);
            Ok(as_json(json!({ "results": results }), paths))
        }
        Call::ListPages { limit, folder, .. } => {
            let mut pages = Vec::new();
            let mut total = 0u64;
            for f in found {
                total += f.value.get("total").and_then(Value::as_u64).ok_or_else(malformed)?;
                for page in list(f.value, "pages")? {
                    pages.push(json!({ "space": f.space, "path": text(page, "path")?, "title": text(page, "title")?, "id": text(page, "id")? }));
                }
            }
            pages.truncate(*limit as usize);
            let truncated = (pages.len() as u64) < total;
            Ok(as_json(json!({ "pages": pages, "total": total, "truncated": truncated }), vec![format!("{folder}/")]))
        }
        Call::ReadPage { .. } => {
            let f = found.first().ok_or_else(malformed)?;
            let page = f.value.get("page").ok_or_else(malformed)?;
            let attachments: Vec<String> =
                list(page, "attachments")?.iter().map(|a| a.as_str().map(str::to_owned).ok_or_else(malformed)).collect::<HostResult<_>>()?;
            let path = text(page, "path")?.to_owned();
            // The page's own text is the answer; attachments are named, never sent (ADR-0021 rule 3).
            let structured = json!({ "space": f.space, "path": path, "id": text(page, "id")?, "title": text(page, "title")?, "attachments": attachments });
            Ok(Answer { text: text(page, "markdown")?.to_owned(), structured, paths: vec![path] })
        }
        Call::Backlinks { limit, .. } => {
            let f = found.first().ok_or_else(malformed)?;
            let page = f.value.get("page").ok_or_else(malformed)?;
            let total = f.value.get("total").and_then(Value::as_u64).ok_or_else(malformed)?;
            let mut links = Vec::new();
            for link in list(f.value, "links")? {
                let line = link.get("line").and_then(Value::as_u64).ok_or_else(malformed)?;
                links.push(json!({ "path": text(link, "path")?, "title": text(link, "title")?, "id": text(link, "id")?, "line": line }));
            }
            links.truncate(*limit as usize);
            let truncated = (links.len() as u64) < total;
            let target = text(page, "path")?.to_owned();
            let mut paths = vec![target.clone()];
            paths.extend(paths_of(&links));
            let structured = json!({ "page": { "space": f.space, "path": target, "id": text(page, "id")?, "title": text(page, "title")? }, "backlinks": links, "total": total, "truncated": truncated });
            Ok(as_json(structured, paths))
        }
    }
}

fn as_json(structured: Value, mut paths: Vec<String>) -> Answer {
    paths.truncate(LOGGED_PATHS);
    let text = serde_json::to_string_pretty(&structured).unwrap_or_default();
    Answer { text, structured, paths }
}

fn paths_of(items: &[Value]) -> Vec<String> {
    items.iter().filter_map(|i| i.get("path").and_then(Value::as_str).map(str::to_owned)).take(LOGGED_PATHS).collect()
}

fn malformed() -> HostError {
    HostError::internal("Thoth's window sent an answer it should not have")
}

fn list<'a>(value: &'a Value, key: &str) -> HostResult<&'a Vec<Value>> {
    value.get(key).and_then(Value::as_array).ok_or_else(malformed)
}

fn text<'a>(value: &'a Value, key: &str) -> HostResult<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or_else(malformed)
}

fn optional_text(args: &Map<String, Value>, key: &str, max_bytes: usize) -> HostResult<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= max_bytes => Ok(Some(s.clone())),
        Some(Value::String(_)) => Err(HostError::bad_argument(format!("{key} is too long"))),
        Some(_) => Err(HostError::bad_argument(format!("{key} must be a string"))),
    }
}

fn limit(args: &Map<String, Value>, limit: Limit) -> HostResult<u64> {
    match args.get("limit") {
        None | Some(Value::Null) => Ok(limit.default),
        Some(v) => match v.as_u64() {
            Some(0) | None => Err(HostError::bad_argument("limit must be a whole number, 1 or more")),
            Some(n) => Ok(n.min(limit.max)),
        },
    }
}

fn page_ref(args: &Map<String, Value>) -> HostResult<PageRef> {
    let path = optional_text(args, "path", MAX_PATH)?;
    let id = optional_text(args, "id", MAX_ID)?;
    match (path, id) {
        (Some(path), None) => Ok(PageRef::Path(page_path(&path)?)),
        (None, Some(id)) if !id.is_empty() && id.chars().all(|c| c.is_ascii_graphic()) => Ok(PageRef::Id(id)),
        (None, Some(_)) => Err(HostError::bad_argument("id must be a page's thoth_id")),
        _ => Err(HostError::bad_argument("Give the page's path or its id (one of them)")),
    }
}

/// A vault-relative path: `/`-separated, no empty, `.` or `..` part, no backslash or control character.
fn page_path(raw: &str) -> HostResult<String> {
    let path = raw.trim();
    if path.is_empty() || path.starts_with('/') || !safe_parts(path) {
        return Err(HostError::bad_argument("path must be a page's path in the Private Space, such as Notes/Plan.md"));
    }
    Ok(path.to_owned())
}

/// A folder in the Private Space, without leading or trailing `/`; "" is the top.
fn folder(raw: &str) -> HostResult<String> {
    let folder = raw.trim().trim_matches('/');
    if folder.is_empty() {
        return Ok(String::new());
    }
    if !safe_parts(folder) {
        return Err(HostError::bad_argument("folder must be a folder in the Private Space, such as Projects/2026"));
    }
    Ok(folder.to_owned())
}

fn safe_parts(path: &str) -> bool {
    !path.chars().any(|c| c.is_control() || c == '\\') && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_every_tools_arguments() {
        assert_eq!(Call::parse("search", &json!({ "query": "  แผนงาน " })).unwrap(), Call::Search { query: "แผนงาน".into(), limit: 10, space: None });
        assert_eq!(
            Call::parse("search", &json!({ "query": "x", "limit": 9999, "space": "Notes" })).unwrap(),
            Call::Search { query: "x".into(), limit: 50, space: Some("Notes".into()) }
        );
        assert_eq!(
            Call::parse("list_pages", &json!({ "folder": "/Projects/2026/" })).unwrap(),
            Call::ListPages { folder: "Projects/2026".into(), limit: 200, space: None }
        );
        assert_eq!(
            Call::parse("read_page", &json!({ "id": "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" })).unwrap().window_args(),
            json!({ "id": "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" })
        );
        assert_eq!(Call::parse("backlinks", &json!({ "path": "A.md", "limit": 3 })).unwrap().window_args(), json!({ "path": "A.md", "limit": 3 }));

        let refused = |tool: &str, args: Value| Call::parse(tool, &args).unwrap_err().code;
        assert_eq!(refused("search", json!({})), "BAD_ARGUMENT");
        assert_eq!(refused("search", json!({ "query": "   " })), "BAD_ARGUMENT");
        assert_eq!(refused("search", json!({ "query": "x".repeat(501) })), "BAD_ARGUMENT");
        assert_eq!(refused("search", json!({ "query": "x", "limit": 0 })), "BAD_ARGUMENT");
        assert_eq!(refused("search", json!({ "query": "x", "limit": "5" })), "BAD_ARGUMENT");
        assert_eq!(refused("search", json!({ "query": 5 })), "BAD_ARGUMENT");
        assert_eq!(refused("search", json!([1])), "BAD_ARGUMENT");
        for path in ["../secret.md", "/etc/passwd", "a/../../b.md", "a//b.md", "a\\b.md", "a\u{0}.md", "", ".thoth/../x"] {
            assert_eq!(refused("read_page", json!({ "path": path })), "BAD_ARGUMENT", "{path:?}");
        }
        assert_eq!(refused("list_pages", json!({ "folder": ".." })), "BAD_ARGUMENT");
        assert_eq!(refused("read_page", json!({})), "BAD_ARGUMENT");
        assert_eq!(refused("read_page", json!({ "path": "A.md", "id": "x" })), "BAD_ARGUMENT");
        assert_eq!(refused("read_page", json!({ "id": "a b" })), "BAD_ARGUMENT");
        assert_eq!(refused("write_page", json!({})), "BAD_ARGUMENT");
    }

    #[test]
    fn the_answer_has_only_the_fields_it_knows_and_keeps_to_the_limit() {
        let call = Call::parse("search", &json!({ "query": "x", "limit": 2 })).unwrap();
        let a = json!({ "hits": [{ "id": "1", "path": "A.md", "title": "A", "snippet": "[x]", "secret": "no" }, { "id": "2", "path": "B.md", "title": "B", "snippet": "" }] });
        let b = json!({ "hits": [{ "id": "3", "path": "C.md", "title": "C", "snippet": "" }] });
        let answer = answer(&call, &[Found { space: "Notes", value: &a }, Found { space: "Work", value: &b }]).unwrap();
        assert_eq!(
            answer.structured,
            json!({ "results": [{ "space": "Notes", "path": "A.md", "title": "A", "id": "1", "snippet": "[x]" }, { "space": "Notes", "path": "B.md", "title": "B", "id": "2", "snippet": "" }] })
        );
        assert_eq!(answer.paths, ["A.md", "B.md"]);
        assert!(!answer.text.contains("secret"));

        let read = Call::parse("read_page", &json!({ "path": "A.md" })).unwrap();
        let page = json!({ "page": { "id": "1", "path": "A.md", "title": "A", "markdown": "# A\n![[pic.png]]\n", "attachments": ["pic.png"] } });
        let answer = super::answer(&read, &[Found { space: "Notes", value: &page }]).unwrap();
        assert_eq!(answer.text, "# A\n![[pic.png]]\n");
        assert_eq!(answer.structured, json!({ "space": "Notes", "path": "A.md", "id": "1", "title": "A", "attachments": ["pic.png"] }));

        assert_eq!(super::answer(&read, &[Found { space: "Notes", value: &json!({ "page": { "path": 1 } }) }]).unwrap_err().code, "INTERNAL");
    }
}
