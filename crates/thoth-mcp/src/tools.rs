//! The four tools (ADR-0021 rule 3) as MCP describes them, and their results. The running app checks the arguments
//! again: this list is what a client shows, not the boundary.
use crate::relay::Failure;
use crate::{INVALID_PARAMS, Rpc};
use serde_json::{Map, Value, json};

const SPACE: &str = "The name of one shared Private Space. Leave it out to use every shared one.";
const PATH: &str = "The page's path in its Private Space, such as Projects/Plan.md.";
const ID: &str = "The page's stable id (thoth_id), as search and list_pages give it. Instead of path.";

/// What `tools/list` answers.
pub fn definitions() -> Value {
    let read_only = |title: &str| json!({ "title": title, "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false });
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
        }
    ])
}

/// A `tools/call` request's tool name (one of the four) and its arguments (an object).
pub fn check(params: &Value) -> Result<(String, Map<String, Value>), Rpc> {
    let name = params.get("name").and_then(Value::as_str).ok_or_else(|| Rpc::new(INVALID_PARAMS, "name must be the tool's name"))?;
    if !["search", "list_pages", "read_page", "backlinks"].contains(&name) {
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
