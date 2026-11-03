//! The four read-only tools of Connected apps (ADR-0021 rule 3): what a request may ask, checked here at the trust
//! boundary (the socket), and the answer built from what the windows' vaults found.
//!
//! The webview runs the queries on its open `Vault`; the host decides which Private Spaces are asked, cuts every list
//! to its limit and builds the answer from the fields it knows, so nothing else a window sends reaches an app.
use crate::error::{HostError, HostResult};
use serde_json::{Map, Value, json};
use std::path::Path;

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

/// One exact-text replacement of `propose_edit_page`: `find` must occur exactly once.
#[derive(Clone, Debug, PartialEq)]
pub struct Replacement {
    pub find: String,
    pub replace: String,
}

/// What `propose_edit_page` changes: the whole page, or exact-text replacements applied in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Edit {
    Markdown(String),
    Replace(Vec<Replacement>),
}

/// One checked tool call.
#[derive(Clone, Debug, PartialEq)]
pub enum Call {
    Search { query: String, limit: u64, space: Option<String> },
    ListPages { folder: String, limit: u64, space: Option<String> },
    ReadPage { page: PageRef, space: Option<String> },
    Backlinks { page: PageRef, limit: u64, space: Option<String> },
    ProposeCreate { path: String, markdown: String, space: Option<String> },
    ProposeEdit { page: PageRef, edit: Edit, expected: Option<String>, space: Option<String> },
    ProposeAppend { page: PageRef, markdown: String, heading: Option<String>, expected: Option<String>, space: Option<String> },
    ListProposals { status: Option<String>, limit: u64 },
    GetProposal { id: String },
}

pub const TOOLS: &[&str] =
    &["search", "list_pages", "read_page", "backlinks", "propose_create_page", "propose_edit_page", "propose_append", "list_proposals", "get_proposal"];
/// The largest proposed page or added text, in bytes: the same as an answer (ADR-0021 rule 3).
pub const MAX_MARKDOWN: usize = 1024 * 1024;
/// The most replacements in one `propose_edit_page`.
pub const MAX_REPLACEMENTS: usize = 100;
pub const PROPOSAL_LIMIT: Limit = Limit { default: 20, max: 100 };
/// Longest page title of `propose_create_page`, in characters (the file name is cut to `MAX_FILE_NAME`).
const MAX_TITLE: usize = 500;
const MAX_FILE_NAME: usize = 120;
const MAX_HEADING: usize = 500;
pub const STATUSES: &[&str] = &["pending", "applied", "declined", "expired", "conflicted"];

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
            "propose_create_page" => {
                let markdown = markdown(args, "markdown")?.unwrap_or_default();
                Ok(Call::ProposeCreate { path: new_page_path(args)?, markdown, space })
            }
            "propose_edit_page" => {
                let edit = match (markdown(args, "markdown")?, args.get("replacements")) {
                    (Some(markdown), None | Some(Value::Null)) => Edit::Markdown(markdown),
                    (None, Some(list)) if !list.is_null() => Edit::Replace(replacements(list)?),
                    _ => return Err(HostError::bad_argument("Give either markdown (the whole new page) or replacements (a list of { find, replace })")),
                };
                Ok(Call::ProposeEdit { page: writable(page_ref(args)?)?, edit, expected: expected(args)?, space })
            }
            "propose_append" => {
                let markdown =
                    markdown(args, "markdown")?.filter(|m| !m.trim().is_empty()).ok_or_else(|| HostError::bad_argument("markdown must be the text to add"))?;
                let heading = optional_text(args, "heading", MAX_HEADING)?.map(|h| heading_text(&h)).filter(|h| !h.is_empty());
                Ok(Call::ProposeAppend { page: writable(page_ref(args)?)?, markdown, heading, expected: expected(args)?, space })
            }
            "list_proposals" => {
                let status = optional_text(args, "status", 32)?;
                if let Some(s) = &status
                    && !STATUSES.contains(&s.as_str())
                {
                    return Err(HostError::bad_argument(format!("status must be one of {}", STATUSES.join(", "))));
                }
                Ok(Call::ListProposals { status, limit: limit(args, PROPOSAL_LIMIT)? })
            }
            "get_proposal" => {
                let id = optional_text(args, "id", 64)?.unwrap_or_default();
                if !is_proposal_id(&id) {
                    return Err(HostError::bad_argument("id must be a proposal's id, as the propose tools give it"));
                }
                Ok(Call::GetProposal { id })
            }
            _ => Err(HostError::bad_argument(format!("Unknown tool {tool:?}"))),
        }
    }

    pub fn tool(&self) -> &'static str {
        match self {
            Call::Search { .. } => "search",
            Call::ListPages { .. } => "list_pages",
            Call::ReadPage { .. } => "read_page",
            Call::Backlinks { .. } => "backlinks",
            Call::ProposeCreate { .. } => "propose_create_page",
            Call::ProposeEdit { .. } => "propose_edit_page",
            Call::ProposeAppend { .. } => "propose_append",
            Call::ListProposals { .. } => "list_proposals",
            Call::GetProposal { .. } => "get_proposal",
        }
    }

    /// What the window is asked to do: a proposal reads the page it changes (`read_page`), nothing else.
    pub fn window_tool(&self) -> &'static str {
        if self.is_proposal() { "read_page" } else { self.tool() }
    }

    pub fn space(&self) -> Option<&str> {
        match self {
            Call::Search { space, .. }
            | Call::ListPages { space, .. }
            | Call::ReadPage { space, .. }
            | Call::Backlinks { space, .. }
            | Call::ProposeCreate { space, .. }
            | Call::ProposeEdit { space, .. }
            | Call::ProposeAppend { space, .. } => space.as_deref(),
            Call::ListProposals { .. } | Call::GetProposal { .. } => None,
        }
    }

    /// Search and the page list look in every shared Private Space; one page is read from, or proposed for, one.
    pub fn one_space(&self) -> bool {
        matches!(self, Call::ReadPage { .. } | Call::Backlinks { .. }) || self.is_proposal()
    }

    /// A change proposed for the user's review (ADR-0048): never written by the call.
    pub fn is_proposal(&self) -> bool {
        matches!(self, Call::ProposeCreate { .. } | Call::ProposeEdit { .. } | Call::ProposeAppend { .. })
    }

    /// Answered by the host from its own proposals, without a window.
    pub fn about_proposals(&self) -> bool {
        matches!(self, Call::ListProposals { .. } | Call::GetProposal { .. })
    }

    /// What a window is asked (`mcp.request`'s `args`): the checked values only. Never the proposed text.
    pub fn window_args(&self) -> Value {
        let page = |page: &PageRef| match page {
            PageRef::Path(path) => json!({ "path": path }),
            PageRef::Id(id) => json!({ "id": id }),
        };
        match self {
            Call::Search { query, limit, .. } => json!({ "query": query, "limit": limit }),
            Call::ListPages { folder, limit, .. } => json!({ "folder": folder, "limit": limit }),
            Call::ReadPage { page: p, .. } | Call::ProposeEdit { page: p, .. } | Call::ProposeAppend { page: p, .. } => page(p),
            Call::ProposeCreate { path, .. } => json!({ "path": path }),
            Call::Backlinks { page: p, limit, .. } => {
                let mut args = page(p);
                args["limit"] = json!(limit);
                args
            }
            Call::ListProposals { .. } | Call::GetProposal { .. } => json!({}),
        }
    }

    /// The paths a log entry keeps for this call when it fails (when it succeeds, `Answer::paths`).
    pub fn asked_paths(&self) -> Vec<String> {
        match self {
            Call::ListPages { folder, .. } => vec![format!("{folder}/")],
            Call::ReadPage { page: PageRef::Path(path), .. }
            | Call::Backlinks { page: PageRef::Path(path), .. }
            | Call::ProposeEdit { page: PageRef::Path(path), .. }
            | Call::ProposeAppend { page: PageRef::Path(path), .. }
            | Call::ProposeCreate { path, .. } => vec![path.clone()],
            _ => Vec::new(),
        }
    }
}

/// The page text a proposal would leave: `current` is the page now (None: it does not exist yet). Exact-text
/// replacements must each match exactly once, in the text as the earlier ones left it; an append under a heading
/// needs that heading exactly once.
pub fn proposed_text(call: &Call, current: Option<&str>) -> HostResult<String> {
    let current = current.unwrap_or_default();
    match call {
        Call::ProposeCreate { markdown, .. } | Call::ProposeEdit { edit: Edit::Markdown(markdown), .. } => Ok(markdown.clone()),
        Call::ProposeEdit { edit: Edit::Replace(list), .. } => {
            let mut text = current.to_owned();
            for (n, r) in list.iter().enumerate() {
                match occurrences(&text, &r.find) {
                    1 => text = text.replacen(r.find.as_str(), &r.replace, 1),
                    0 => return Err(HostError::bad_argument(format!("replacements[{n}]: find is not in the page: read it again and copy the text exactly"))),
                    _ => {
                        return Err(HostError::bad_argument(format!(
                            "replacements[{n}]: find is in the page more than once: give more of the text around it so it matches once"
                        )));
                    }
                }
            }
            Ok(text)
        }
        Call::ProposeAppend { markdown, heading, .. } => {
            let (before, after) = match heading {
                None => (current, ""),
                Some(heading) => current.split_at(section_end(current, heading)?),
            };
            let mut text = before.trim_end_matches(['\n', '\r']).to_owned();
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(markdown.trim_matches(['\n', '\r']));
            text.push('\n');
            if !after.is_empty() {
                text.push('\n');
                text.push_str(after);
            }
            Ok(text)
        }
        _ => Err(HostError::internal("Not a proposal")),
    }
}

/// How often `find` occurs in `text`, overlapping ones too ("aa" is twice in "aaa"), counted up to 2: 0, 1 or "more".
fn occurrences(text: &str, find: &str) -> usize {
    let step = find.chars().next().map_or(1, char::len_utf8);
    let mut found = 0;
    let mut from = 0;
    while found < 2
        && let Some(at) = text[from..].find(find)
    {
        found += 1;
        from += at + step;
    }
    found
}

/// Where the section under the one heading whose text is `heading` ends: at the next heading of the same or a
/// higher level, or at the end. Headings in code blocks and the front matter do not count.
fn section_end(text: &str, heading: &str) -> HostResult<usize> {
    // Every heading outside the front matter and code blocks: (level, text, where its line starts).
    let mut headings: Vec<(usize, String, usize)> = Vec::new();
    let mut fence: Option<&str> = None;
    let mut front_matter = text.starts_with("---\n") || text.starts_with("---\r\n");
    let mut offset = 0;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        let start = offset;
        offset += raw.len();
        let line = raw.trim_end_matches(['\n', '\r']);
        if front_matter {
            front_matter = i == 0 || !(line == "---" || line == "...");
            continue;
        }
        let trimmed = line.trim_start_matches(' ');
        if let Some(marker) = ["```", "~~~"].into_iter().find(|m| trimmed.starts_with(m)).filter(|_| line.len() - trimmed.len() <= 3) {
            fence = match fence {
                None => Some(marker),
                Some(open) if open == marker => None,
                open => open,
            };
            continue;
        }
        if fence.is_none()
            && let Some((level, title)) = atx_heading(line)
        {
            headings.push((level, title, start));
        }
    }
    let matching: Vec<usize> = headings.iter().enumerate().filter(|(_, h)| h.1 == heading).map(|(i, _)| i).collect();
    match matching.as_slice() {
        [i] => Ok(headings[i + 1..].iter().find(|h| h.0 <= headings[*i].0).map_or(text.len(), |h| h.2)),
        [] => Err(HostError::bad_argument(format!("No heading {heading:?} in the page: read it and give a heading's text exactly"))),
        many => Err(HostError::bad_argument(format!("The page has {} headings {heading:?}: add at the end instead, or propose an edit", many.len()))),
    }
}

/// An ATX heading (`## Title ##`): its level and its text.
fn atx_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    let rest = &trimmed[level..];
    if !(1..=6).contains(&level) || !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    Some((level, heading_text(rest)))
}

/// A heading's text without its `#` marks and the spaces around it.
fn heading_text(raw: &str) -> String {
    let text = raw.trim().trim_start_matches('#').trim();
    let closed = text.trim_end_matches('#');
    if closed.len() < text.len() && (closed.is_empty() || closed.ends_with([' ', '\t'])) { closed.trim().to_owned() } else { text.to_owned() }
}

/// `prop_` and 32 lowercase hex digits (`handles::new_handle("prop")`).
pub fn is_proposal_id(id: &str) -> bool {
    id.strip_prefix("prop_").is_some_and(|hex| hex.len() == 32 && hex.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)))
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
            let mut structured = json!({ "space": f.space, "path": path, "id": text(page, "id")?, "title": text(page, "title")?, "attachments": attachments });
            // The page's version, for a proposal's `expected` (ADR-0048).
            if let Some(hash) = page.get("hash").and_then(Value::as_str) {
                structured["version"] = json!(hash);
            }
            Ok(Answer { text: text(page, "markdown")?.to_owned(), structured, paths: vec![path] })
        }
        Call::ProposeCreate { .. } | Call::ProposeEdit { .. } | Call::ProposeAppend { .. } | Call::ListProposals { .. } | Call::GetProposal { .. } => {
            Err(HostError::internal("Proposals are answered by the host"))
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

/// Proposed Markdown: a string of at most `MAX_MARKDOWN` bytes (`TOO_LARGE` beyond).
fn markdown(args: &Map<String, Value>, key: &str) -> HostResult<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= MAX_MARKDOWN => Ok(Some(s.clone())),
        Some(Value::String(_)) => Err(HostError::new("TOO_LARGE", format!("{key} is over 1 MB: propose a smaller change"))),
        Some(_) => Err(HostError::bad_argument(format!("{key} must be a string of Markdown"))),
    }
}

fn replacements(list: &Value) -> HostResult<Vec<Replacement>> {
    let bad = || HostError::bad_argument("replacements must be a list of { find, replace }, find not empty");
    let items = list.as_array().filter(|l| !l.is_empty()).ok_or_else(bad)?;
    if items.len() > MAX_REPLACEMENTS {
        return Err(HostError::bad_argument(format!("At most {MAX_REPLACEMENTS} replacements at once")));
    }
    items
        .iter()
        .map(|item| {
            let find = item.get("find").and_then(Value::as_str).filter(|f| !f.is_empty()).ok_or_else(bad)?;
            let replace = item.get("replace").and_then(Value::as_str).ok_or_else(bad)?;
            Ok(Replacement { find: find.to_owned(), replace: replace.to_owned() })
        })
        .collect()
}

/// The page version the app read (`read_page`'s `version`), which must still be the page's when it proposes.
fn expected(args: &Map<String, Value>) -> HostResult<Option<String>> {
    let version = optional_text(args, "expected", MAX_ID)?;
    if version.as_deref().is_some_and(|v| v.is_empty() || !v.chars().all(|c| c.is_ascii_graphic())) {
        return Err(HostError::bad_argument("expected must be a page version, as read_page gives it"));
    }
    Ok(version)
}

/// A page a proposal may touch: a Markdown file, not in a hidden folder such as `.thoth/`.
fn writable(page: PageRef) -> HostResult<PageRef> {
    if let PageRef::Path(path) = &page {
        confined_page(path)?;
    }
    Ok(page)
}

fn confined_page(path: &str) -> HostResult<()> {
    let markdown = Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"));
    if !markdown || path.split('/').any(|part| part.starts_with('.')) {
        return Err(HostError::bad_argument("path must be a Markdown page (.md) in the Private Space, not in a hidden folder"));
    }
    Ok(())
}

/// The new page's path: `path`, or `folder` (optional) and `title` (the file name, cleaned).
fn new_page_path(args: &Map<String, Value>) -> HostResult<String> {
    let path = optional_text(args, "path", MAX_PATH)?;
    let title = optional_text(args, "title", MAX_TITLE * 4)?;
    let folder = optional_text(args, "folder", MAX_PATH)?;
    let path = match (path, title) {
        (Some(path), None) if folder.is_none() => page_path(&path)?,
        (None, Some(title)) => {
            let folder = folder.map(|f| self::folder(&f)).transpose()?.unwrap_or_default();
            let name = file_name(&title)?;
            if folder.is_empty() { name } else { format!("{folder}/{name}") }
        }
        _ => return Err(HostError::bad_argument("Give the new page's path, or a title (and a folder if you like)")),
    };
    if path.len() > MAX_PATH {
        return Err(HostError::bad_argument("path is too long"));
    }
    confined_page(&path)?;
    Ok(path)
}

/// A title as a file name: characters that cannot be in one (or that break a `[[link]]`) become spaces.
fn file_name(title: &str) -> HostResult<String> {
    if title.chars().count() > MAX_TITLE {
        return Err(HostError::bad_argument(format!("title is longer than {MAX_TITLE} characters")));
    }
    let cleaned: String = title.chars().map(|c| if c.is_control() || "/\\:*?\"<>|#^[]".contains(c) { ' ' } else { c }).collect();
    let name: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ").trim_start_matches('.').trim().chars().take(MAX_FILE_NAME).collect();
    if name.is_empty() {
        return Err(HostError::bad_argument("title must have some letters or numbers"));
    }
    Ok(format!("{}.md", name.trim_end()))
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

    fn text_of(tool: &str, args: Value, page: Option<&str>) -> HostResult<String> {
        proposed_text(&Call::parse(tool, &args)?, page)
    }

    #[test]
    fn replacements_must_each_match_exactly_once_in_order() {
        let page = "# A\n\nred and blue\n\nred\n";
        let edit = |list: Value| text_of("propose_edit_page", json!({ "path": "A.md", "replacements": list }), Some(page));
        assert_eq!(edit(json!([{ "find": "and blue", "replace": "or green" }])).unwrap(), "# A\n\nred or green\n\nred\n");
        // In order: the second sees what the first left.
        assert_eq!(
            edit(json!([{ "find": "red and", "replace": "pink and" }, { "find": "red", "replace": "rose" }])).unwrap(),
            "# A\n\npink and blue\n\nrose\n"
        );
        assert!(edit(json!([{ "find": "red", "replace": "x" }])).unwrap_err().message.contains("more than once"));
        // Overlapping matches count too: "aa" is in "aaa" twice, so it is refused, never replaced at a guess.
        let overlap =
            |find: &str| text_of("propose_edit_page", json!({ "path": "A.md", "replacements": [{ "find": find, "replace": "b" }] }), Some("aaa ไทยไทย"));
        assert!(overlap("aa").unwrap_err().message.contains("more than once"));
        assert!(overlap("ไทย").unwrap_err().message.contains("more than once"));
        assert_eq!(overlap("aaa").unwrap(), "b ไทยไทย");
        assert_eq!(overlap("ยไ").unwrap(), "aaa ไทbทย");
        assert!(edit(json!([{ "find": "purple", "replace": "x" }])).unwrap_err().message.contains("not in the page"));
        assert_eq!(edit(json!([{ "find": "", "replace": "x" }])).unwrap_err().code, "BAD_ARGUMENT");
        assert_eq!(edit(json!([{ "find": "red" }])).unwrap_err().code, "BAD_ARGUMENT");
        assert_eq!(edit(json!([])).unwrap_err().code, "BAD_ARGUMENT");
        let many: Vec<Value> = (0..=MAX_REPLACEMENTS).map(|i| json!({ "find": i.to_string(), "replace": "" })).collect();
        assert_eq!(edit(Value::Array(many)).unwrap_err().code, "BAD_ARGUMENT");
    }

    #[test]
    fn an_addition_goes_at_the_end_or_at_the_end_of_a_headings_section() {
        let page = "---\n# not a heading\n---\n# Plan\n\nintro\n\n## Tasks\n\n- a\n\n```\n## Tasks\n```\n\n### Detail\n\nd\n\n## Notes\n\nn\n";
        let add = |heading: Option<&str>| text_of("propose_append", json!({ "path": "Plan.md", "markdown": "\n- b\n", "heading": heading }), Some(page));
        assert_eq!(add(None).unwrap(), format!("{page}\n- b\n"));
        // The section runs past its sub-headings to the next heading of its level; the one in code does not count.
        assert_eq!(add(Some("Tasks")).unwrap(), page.replace("d\n\n## Notes", "d\n\n- b\n\n## Notes"));
        assert_eq!(add(Some("## Tasks ##")).unwrap(), add(Some("Tasks")).unwrap());
        assert_eq!(add(Some("Notes")).unwrap(), format!("{page}\n- b\n"));
        assert!(add(Some("not a heading")).unwrap_err().message.contains("No heading"));
        let twice = "# A\n## X\n## X\n";
        assert!(text_of("propose_append", json!({ "path": "A.md", "markdown": "y", "heading": "X" }), Some(twice)).unwrap_err().message.contains("2 headings"));
        assert_eq!(text_of("propose_append", json!({ "path": "A.md", "markdown": "y" }), Some("")).unwrap(), "y\n");
        assert_eq!(Call::parse("propose_append", &json!({ "path": "A.md", "markdown": "  \n" })).unwrap_err().code, "BAD_ARGUMENT");
    }

    #[test]
    fn a_new_page_has_a_safe_markdown_path() {
        let path = |args: Value| match Call::parse("propose_create_page", &args) {
            Ok(Call::ProposeCreate { path, .. }) => Ok(path),
            Ok(other) => panic!("{other:?}"),
            Err(e) => Err(e.code),
        };
        assert_eq!(path(json!({ "title": "แผนงาน: Q1 [draft]", "markdown": "" })), Ok("แผนงาน Q1 draft.md".to_owned()));
        assert_eq!(path(json!({ "title": "x", "folder": "/A/B/", "markdown": "" })), Ok("A/B/x.md".to_owned()));
        assert_eq!(path(json!({ "path": "A/Note.markdown", "markdown": "" })), Ok("A/Note.markdown".to_owned()));
        assert_eq!(path(json!({ "title": "...hidden", "markdown": "" })), Ok("hidden.md".to_owned()));
        for bad in [
            json!({ "markdown": "" }),
            json!({ "path": "A.md", "title": "A" }),
            json!({ "path": "A.md", "folder": "B" }),
            json!({ "title": "x", "folder": ".thoth" }),
            json!({ "title": "x".repeat(501) }),
            json!({ "path": "A.md", "markdown": 1 }),
        ] {
            assert_eq!(path(bad.clone()), Err("BAD_ARGUMENT"), "{bad}");
        }
        assert_eq!(path(json!({ "path": "A.md", "markdown": "x".repeat(MAX_MARKDOWN + 1) })), Err("TOO_LARGE"));
        assert!(is_proposal_id("prop_0123456789abcdef0123456789abcdef"));
        assert!(!is_proposal_id("prop_0123456789ABCDEF0123456789abcdef") && !is_proposal_id("mcp_0123456789abcdef0123456789abcdef"));
        assert_eq!(Call::parse("get_proposal", &json!({ "id": "../x" })).unwrap_err().code, "BAD_ARGUMENT");
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
