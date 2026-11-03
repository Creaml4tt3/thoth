//! The tools as MCP describes them, and their results: four that read (ADR-0021 rule 3), three that propose changes
//! for the user to review in Thoth and two that tell what became of them (ADR-0048). The running app checks the
//! arguments again: this list is what a client shows, not the boundary.
use crate::relay::Failure;
use crate::{INVALID_PARAMS, Rpc};
use serde_json::{Map, Value, json};

const SPACE: &str = "The name of one shared Private Space. Leave it out to use every shared one.";
const PATH: &str = "The page's path in its Private Space, such as Projects/Plan.md.";
const ID: &str = "The page's stable id (thoth_id), as search and list_pages give it. Instead of path.";
const ONE_SPACE: &str = "The page's Private Space. Needed when more than one is shared.";
const EXPECTED: &str = "The page's version this change is based on (read_page's version). If the page changed since, nothing is proposed.";
const REVIEWED: &str =
    " Nothing is written now: the user reviews the change in Thoth and applies or declines it. The answer is the proposal's id, with status pending.";

/// The tools' names, in the order `tools/list` gives them.
pub const NAMES: &[&str] =
    &["search", "list_pages", "read_page", "backlinks", "propose_create_page", "propose_edit_page", "propose_append", "list_proposals", "get_proposal"];

/// What `tools/list` answers.
pub fn definitions() -> Value {
    let read_only = |title: &str| json!({ "title": title, "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false });
    // A proposal changes nothing until the user applies it, and then only with compare-and-swap.
    let proposes = |title: &str| json!({ "title": title, "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false });
    json!([
        {
            "name": "search",
            "title": "Search notes",
            "description": "Full-text search in the Private Spaces the user shares with this app. Words in any language, Thai too, and parts of words are found. Gives each page's space, path, title, id and a snippet with the matches in [brackets].",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "maxLength": 500, "description": "What to look for." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10, "description": "The most pages to give." },
                    "space": { "type": "string", "description": SPACE }
                },
                "required": ["query"],
                "additionalProperties": false
            },
            "annotations": read_only("Search notes")
        },
        {
            "name": "list_pages",
            "title": "List pages",
            "description": "Lists the pages (paths, titles and ids) of the shared Private Spaces, or of one folder in them. Attachments are not listed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": { "type": "string", "description": "Only pages under this folder, such as Projects. Leave it out for every page." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 200, "description": "The most pages to give; `truncated` says when there are more." },
                    "space": { "type": "string", "description": SPACE }
                },
                "additionalProperties": false
            },
            "annotations": read_only("List pages")
        },
        {
            "name": "read_page",
            "title": "Read a page",
            "description": "Gives one page's Markdown text, by its path or its id. The attachments it links to are named, not sent.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH },
                    "id": { "type": "string", "description": ID },
                    "space": { "type": "string", "description": "The page's Private Space. Needed when more than one is shared." }
                },
                "additionalProperties": false
            },
            "annotations": read_only("Read a page")
        },
        {
            "name": "backlinks",
            "title": "Pages that link here",
            "description": "Lists the pages that link to one page (by its path or its id), with the line of each link.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH },
                    "id": { "type": "string", "description": ID },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50, "description": "The most links to give." },
                    "space": { "type": "string", "description": "The page's Private Space. Needed when more than one is shared." }
                },
                "additionalProperties": false
            },
            "annotations": read_only("Pages that link here")
        },
        {
            "name": "propose_create_page",
            "title": "Propose a new page",
            "description": format!("Proposes a new page in a shared Private Space: its path, or a title (and a folder), and its Markdown. A page that already exists is never replaced.{REVIEWED}"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The new page's path, such as Projects/Plan.md. Instead of title." },
                    "title": { "type": "string", "description": "The new page's title; its file name is made from it." },
                    "folder": { "type": "string", "description": "The folder for a page given by title, such as Projects. Leave it out for the top." },
                    "markdown": { "type": "string", "maxLength": 1_048_576, "description": "The page's Markdown." },
                    "space": { "type": "string", "description": ONE_SPACE }
                },
                "required": ["markdown"],
                "additionalProperties": false
            },
            "annotations": proposes("Propose a new page")
        },
        {
            "name": "propose_edit_page",
            "title": "Propose a change to a page",
            "description": format!("Proposes a change to one page, by its path or id: either the whole new Markdown, or replacements, each an exact piece of the page's text (find, which must be in the page exactly once) and what replaces it. Replacements apply in order.{REVIEWED}"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH },
                    "id": { "type": "string", "description": ID },
                    "markdown": { "type": "string", "maxLength": 1_048_576, "description": "The whole new Markdown of the page. Instead of replacements." },
                    "replacements": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 100,
                        "description": "Exact-text replacements. Instead of markdown.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": { "type": "string", "minLength": 1, "description": "Text in the page, exactly as it is there; it must occur once." },
                                "replace": { "type": "string", "description": "What replaces it (may be empty)." }
                            },
                            "required": ["find", "replace"],
                            "additionalProperties": false
                        }
                    },
                    "expected": { "type": "string", "description": EXPECTED },
                    "space": { "type": "string", "description": ONE_SPACE }
                },
                "additionalProperties": false
            },
            "annotations": proposes("Propose a change to a page")
        },
        {
            "name": "propose_append",
            "title": "Propose an addition to a page",
            "description": format!("Proposes adding Markdown at the end of a page, or at the end of the section under one of its headings (given by the heading's text).{REVIEWED}"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH },
                    "id": { "type": "string", "description": ID },
                    "markdown": { "type": "string", "minLength": 1, "maxLength": 1_048_576, "description": "The Markdown to add." },
                    "heading": { "type": "string", "description": "Add under this heading (its text, without the # marks). It must be in the page once. Leave it out to add at the end." },
                    "expected": { "type": "string", "description": EXPECTED },
                    "space": { "type": "string", "description": ONE_SPACE }
                },
                "required": ["markdown"],
                "additionalProperties": false
            },
            "annotations": proposes("Propose an addition to a page")
        },
        {
            "name": "list_proposals",
            "title": "List my proposals",
            "description": "Lists the changes this app proposed in the last 7 days, newest first, with what became of each: pending (waiting for review), applied, declined, expired (not reviewed in 7 days) or conflicted (the page changed before it was applied; the user decides).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["pending", "applied", "declined", "expired", "conflicted"], "description": "Only proposals with this status." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20, "description": "The most proposals to give." }
                },
                "additionalProperties": false
            },
            "annotations": read_only("List my proposals")
        },
        {
            "name": "get_proposal",
            "title": "What became of a proposal",
            "description": "Gives one of this app's proposals by its id: its page and its status (pending, applied, declined, expired or conflicted).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "The proposal's id, as a propose tool gave it." } },
                "required": ["id"],
                "additionalProperties": false
            },
            "annotations": read_only("What became of a proposal")
        }
    ])
}

/// A `tools/call` request's tool name (one of `NAMES`) and its arguments (an object).
pub fn check(params: &Value) -> Result<(String, Map<String, Value>), Rpc> {
    let name = params.get("name").and_then(Value::as_str).ok_or_else(|| Rpc::new(INVALID_PARAMS, "name must be the tool's name"))?;
    if !NAMES.contains(&name) {
        return Err(Rpc::new(INVALID_PARAMS, format!("Unknown tool: {name}")));
    }
    let arguments = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(arguments)) => arguments.clone(),
        Some(_) => return Err(Rpc::new(INVALID_PARAMS, "arguments must be an object")),
    };
    Ok((name.to_owned(), arguments))
}

/// A `CallToolResult`: the app's text and structured answer, or its error as text the model can read (`isError`).
pub fn result(outcome: Result<Value, Failure>) -> Value {
    match outcome {
        Ok(answer) => {
            let text = answer.get("text").and_then(Value::as_str).unwrap_or_default();
            let mut result = json!({ "content": [{ "type": "text", "text": text }] });
            if let Some(structured) = answer.get("structured").filter(|s| !s.is_null()) {
                result["structuredContent"] = structured.clone();
            }
            result
        }
        Err(failure) => json!({ "content": [{ "type": "text", "text": failure.message }], "isError": true }),
    }
}
