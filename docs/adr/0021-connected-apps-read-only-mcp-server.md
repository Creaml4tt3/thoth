# ADR-0021: Connected apps: a read-only MCP server

- **Status:** Accepted (owner, 2026-10-26)
- **Date:** 2026-10-26
- **Deciders:** project owner (the request, 2026-10-25); rules 1 to 6 were decided by the orchestrator for the owner.
  The details marked "(this ADR)" were decided while implementing them.
- **Refines:** ADR-0001 (Markdown files are the source; the index is a cache), ADR-0003 (stable ids), ADR-0007
  (agent safety: review before apply, compare-and-swap), ADR-0008 (the webview runs the vault logic over the host's
  ports), ADR-0019 (several windows on one Private Space, one index connection each), ADR-0020 (how host commands are
  added).

## Context

The owner asked on 2026-10-25: "Make MCP for other apps can connect to."

The Model Context Protocol (MCP) is how assistants such as Claude Desktop or Cursor reach local tools. A client
starts a local server as a child process and speaks JSON-RPC to it on stdin and stdout.

Facts this ADR relies on were checked on 2026-10-26 against modelcontextprotocol.io and the specification
repository. Paraphrased:

- **Current version: 2026-07-28** ([Versioning](https://modelcontextprotocol.io/specification/versioning)).
  - There is no handshake. Every request names its protocol version in
    `_meta["io.modelcontextprotocol/protocolVersion"]`, and its client in `…/clientInfo` and `…/clientCapabilities`.
  - The server checks each request on its own. A version it does not support gets `UnsupportedProtocolVersionError`
    (code `-32022`, listing the supported versions).
  - Servers must implement `server/discover`. Results carry `resultType` ("complete"). Lists and discovery are
    cacheable (`ttlMs`, `cacheScope`).
- **Earlier versions (2025-11-25 and before) use the `initialize` handshake**
  ([Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle)).
  - The client sends `protocolVersion`, `capabilities` and `clientInfo`. The server answers with the version it will
    speak, its `capabilities` and `serverInfo`, then the client sends `notifications/initialized`.
  - A "dual-era" server may serve both. It chooses legacy behaviour when a client opens with `initialize`, and the
    modern behaviour for requests that carry the modern `_meta`.
- **stdio** ([stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)) is
  newline-delimited JSON-RPC.
  - Messages contain no embedded newline, and stdout carries nothing but MCP messages.
  - Cancellation is `notifications/cancelled`; a cancelled request gets no further message.
  - The server should exit when its stdin closes.
  - A custom transport over a byte stream (such as a Unix socket) should reuse that framing
    ([Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)).
- **Tools** (`schema.ts`, both versions, in
  [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)).
  - `tools/list` describes tools by `name`, `inputSchema` (a JSON Schema object) and optional `annotations`
    (`readOnlyHint` and others, all hints).
  - `tools/call` answers with `content` (text blocks), optional `structuredContent` and `isError`.
  - A tool's own failure belongs in the result with `isError: true`, so the model can read it. An unknown tool is a
    protocol error (`-32602`).
- **`clientInfo` is self-reported.** The 2026-07-28 schema says servers should not rely on it for security decisions.

Constraints from Thoth:

- The vault logic is TypeScript in the webview, over the Rust host's ports (ADR-0008). Every window has its own
  `Vault` and its own index connection on the same folder (ADR-0019).
- Recovery and reconcile write the index. ADR-0019 has the first window on a folder recover and later ones not.
- Agent changes are applied only after review, with compare-and-swap (ADR-0007).
- A Private Space is plain files the user owns. Any program of the same user can already read them.

## Decision

1. **Shape: a stdio sidecar that relays to the running app.**
   - `thoth-mcp` (`crates/thoth-mcp`) is a small Rust program shipped inside the app as Tauri `externalBin`. An MCP
     client starts it from its own settings.
   - It opens no vault and keeps no state. Each tool call goes over a local socket to the running Thoth app as one
     JSON line, and the answer comes back as one JSON line.
   - The host (`crates/thoth-host/src/mcp`) checks the call and sends it to the window that has the Private Space
     open (event `mcp.request`). That window answers from its open `Vault` (`mcp.answer`). The host builds the reply
     from the fields it knows.
   - **Socket (this ADR).** The Unix socket is `<app data>/mcp/thoth.sock`, mode `0600`, in a `0700` folder.
     - The host checks the folder is a real directory owned by the effective user; a symlink or someone else's folder
       is refused.
     - A stale socket is replaced, but a live one (another copy of Thoth) is left alone.
     - The socket only exists while Connected apps is on.
   - **Not running or switched off.** When Thoth is not running or Connected apps is off, every tool answers with a
     tool error: "Thoth is not running, or Connected apps is off. Open Thoth and switch on Connected apps (Settings →
     Connected apps), then try again."
   - **Why the relay** (it was kept; reading the vault directly would be worse):
     - A third process on the index would break ADR-0019's single recovery and its write ordering.
     - It would need the TypeScript vault logic (parsing, link resolution, FTS queries) again in Rust, or a second
       runtime, which ADR-0008 rejected.
     - It could not ask the user anything.
     - The relay costs that Thoth must be running with the Private Space open in a window. That is stated in Settings.
2. **Off by default, and the user decides everything** (Settings → Connected apps).
   - A switch turns it on or off.
   - Private Spaces are shared one by one, with a tick for each. Only folders the user opened can be ticked: the
     host's recent list and the open ones.
   - The section lists the apps that connected, by `clientInfo.name`. It says that the name is the app's own and
     Thoth cannot check it.
   - "Copy the setup" puts `{"mcpServers": {"thoth": {"command": <sidecar path>, "args": ["--socket", <socket>]}}}`
     on the clipboard. That is the form Claude Desktop and Cursor read. The sidecar path is next to the app's own
     program.
   - **First connection.** The first time an app name connects, every window asks "Let “name” read your notes?" with
     Allow and Deny.
     - The request waits up to 60 seconds for the answer. Without an answer it fails, and the question stays until it
       is answered.
     - The answer is remembered per name. Allow can be revoked (Deny), and Remove forgets the app, so it is asked
       about again.
     - Focus starts on Deny, and Escape does not answer (this ADR).
     - Names are cleaned before they are shown or stored (this ADR): control characters and invisible formatting
       characters (bidirectional controls, zero-width) are removed, spaces are collapsed, and the name is cut to 64
       characters. An app that gives no name is "Unnamed app".
3. **Read only: four tools, no resources** (this ADR: tools only, no MCP resources or prompts).
   - `search` is the existing FTS, with the trigram fallback for Thai and parts of words.
   - `list_pages` gives paths, titles and ids, optionally under one folder.
   - `read_page` gives one page's Markdown, by path or by `thoth_id` (ADR-0003). The attachments it links to are
     named, never sent.
   - `backlinks` gives the pages that link to one page, with the line of each link.
   - Each tool's `annotations` say `readOnlyHint: true` and `openWorldHint: false`.
   - **Results.** Each result is `text` for the model and `structuredContent` for the app. For `read_page` the text is
     the Markdown.
     - Results name their Private Space as `space`, its folder name.
     - When more than one is shared, `read_page` and `backlinks` need `space`.
   - **What can be read.** Only indexed pages are found, never `.thoth/`, an attachment or a path outside the Private
     Space. Workspaces are not exposed: their access is the server's.
   - **Limits.**

     | Limit | Value |
     |---|---|
     | `search` results | 1 to 50 (default 10) |
     | `list_pages` pages | 1 to 500 (default 200) |
     | `backlinks` links | 1 to 200 (default 50) |
     | Query length | at most 500 characters |
     | Request line | at most 64 KiB |
     | Answer | at most 1 MB (`TOO_LARGE`) |
     | Windows' answer time | 15 s per request (`TIMEOUT`) |
     | Reading the request line | 5 s |
     | Connections at once | at most 8 |
     | Apps waiting for an answer | at most 4 |
     | Apps remembered | at most 64 |

4. **Writes are a later step** (Open questions). They will be proposed changes reviewed in the app, as an agent run's
   are, and applied with compare-and-swap (ADR-0007). Nothing in this version writes.
5. **The request log.**
   - Every request is logged in `<app data>/mcp/log/YYYY-MM-DD.jsonl`, one file per day (UTC), each `0600`.
   - An entry holds the time, the app, the tool, the Private Spaces, the page paths (at most 50) and how the request
     ended (`ok`, or the error code). It never holds page text or search words.
   - Files older than 30 days are deleted.
   - Settings shows the newest 500 entries.
6. **Web client: nothing.** No command, setting or string of this reaches the web bundle (`apps/web/test/bundle.ts`).

**MCP side** (this ADR). `thoth-mcp` is a dual-era server with hand-written JSON-RPC: about 500 lines, using only
`serde_json` and `rustix`.

- **2026-07-28 requests:** `server/discover`, the `resultType`, `ttlMs` and `cacheScope` fields, the client named
  in `_meta`, and `-32022` for another version.
- **The 2025-11-25 handshake.** `initialize` answers with the version asked for if it is 2025-11-25, 2025-06-18,
  2025-03-26 or 2024-11-05, and 2025-11-25 otherwise.
- **Other requests.**
  - `ping` is answered.
  - Tool calls run on their own threads, so a ping is answered while a call waits for the user's Allow.
  - A cancelled call is never answered.
  - The server exits when its stdin closes.
- **Shape tests.** Every answer is checked against the official JSON schemas of both versions (vendored in
  `tests/fixtures/mcp-schema`).

**Host commands** (desktop capability, nothing else added):

| Command | Purpose |
|---|---|
| `mcp.settings` | The current settings |
| `mcp.configure` | The switch and the shared Private Spaces |
| `mcp.decide` | Allow or Deny for an app |
| `mcp.forget` | Remove an app |
| `mcp.answer` | A window's answer to a request |
| `mcp.log` | The request log |

The host's events are `mcp.request` and `mcp.pending`; the shell sends them as `thoth:mcp-request` and
`thoth:mcp-pending`.

## Security model

- **Who can connect.**
  - Only processes of the same user. The socket is `0600` in a `0700` folder that the host checks belongs to the
    user, and it exists only while the switch is on.
  - `thoth-mcp` refuses a socket path that is a symlink, not a socket, or not owned by the user.
  - The peer's credentials (`SO_PEERCRED`, `getpeereid`) are not checked; the file permissions are the control
    (Open questions).
- **What an app name means.** Allow and Deny are the user's consent for a name, not authentication. Any program of
  this user can claim any name and could connect to the socket directly. The UI says so.
  - This adds no new reach. Such a program can already read the Private Space's files.
  - What Connected apps adds is a supported, logged and consented way for apps the user chose. It also makes apps the
    user did not allow fail clearly.
- **What is reachable.**
  - Reachable: Private Spaces the user ticked, that are open in a window, through four read-only tools. Paths are
    checked at the socket (no `..`, absolute path, backslash or control character) and found only in the index.
  - Not reachable: unshared Private Spaces, which are not named in answers or errors. Workspaces, attachments' bytes
    and `.thoth/` are not reachable either.
  - Answers are built by the host from known fields. Anything else a window sends does not reach the app.
- **The webview** (ADR-0008 treats it as untrusted).
  - The switch, the ticks and Allow/Deny are set from the webview. A compromised webview could share a Private Space
    it already reads and allow a name.
  - That reaches only processes of the same user, who can read those files anyway.
  - A window may answer only a request sent to it: `mcp.answer` checks that the caller is the window asked. Each
    window also checks the request's `owner` and `root`, since every Tauri listener hears every event.
- **Abuse by a local program.** It is bounded by:
  - the limits in rule 3;
  - at most 4 apps waiting for an answer, and 64 remembered;
  - read timeouts on the socket;
  - the cleaned names in the question, so a name cannot pose as another with bidirectional characters.

## Consequences

- Positive: assistants can search and read the user's notes without a copy of the vault. The user consents per app
  and per Private Space, sees every request, and can switch it all off.
- Positive: one index owner per window (ADR-0019) holds. The answers are the app's own search and link resolution,
  Thai included.
- Negative: Thoth must be running, with the Private Space open in a window.
- Negative: the app name is not verified. A Linux AppImage's sidecar path changes on every launch, because the image
  is mounted somewhere new; use the `.deb` there (Open questions).
- Negative: Windows is not built yet. The host reports `UNAVAILABLE`, and Settings says "not available on this
  computer yet".
- Follow-up:
  - The release workflow builds the sidecar (`scripts/build-mcp-sidecar.ts`; macOS universal via `lipo`) and merges
    `src-tauri/tauri.sidecar.conf.json` into `tauri build`. `cargo test` and `tauri dev` need no built sidecar.
  - `cargo test -p thoth-mcp` runs in the Windows test job.

## Alternatives considered

- **The official Rust SDK (`rmcp`).** It brings an async runtime and much more than four tools over stdio need, and
  every dependency must be pinned and three weeks old. Hand-written JSON-RPC is small and fully tested against the
  official schemas. Prefer the SDK if Thoth later needs Streamable HTTP or the Tasks extension.
- **`thoth-mcp` reads the vault itself.** Rejected for the reasons in rule 1.
- **An HTTP server on localhost (Streamable HTTP).** Any local process, and any web page through DNS rebinding,
  could reach it; it would need tokens and origin checks. Clients start stdio servers themselves, and a Unix socket
  is protected by the file system.
- **A native Allow/Deny dialog from the host** (not the webview). The webview could not then forge the consent, but
  the e2e bridge cannot drive it, and it adds nothing against same-user programs. Reconsider together with writes.

## Spec references

Section 3.3 (local access), section 4 (runtime boundary), section 12 (desktop), section 14.11 (the web client has
no local access).

## Open questions

- **Writes (rule 4).** A proposed change should be shown like an agent run's review and applied with compare-and-swap.
  This needs a design for proposals from outside (who, how many, how long kept) and probably a native confirmation.
  It blocks any write tool.
- **Windows.** A named pipe with an owner-only DACL and `PIPE_REJECT_REMOTE_CLIENTS`. The client must check the
  pipe server's owner (pipe-name squatting by another user). Not built: it could not be built or tested here. It
  blocks Connected apps on Windows.
- **Peer credentials** (`SO_PEERCRED` on Linux, `getpeereid` on macOS) as defense in depth. It needs `libc` or a
  `rustix` feature, at least three weeks old.
- **The Linux AppImage path.** Point the setup at a stable copy, or document the `.deb`. It blocks a reliable "Copy
  the setup" on AppImage.
- **MCP resources** (pages as `thoth://` resources) and `notifications/tools/list_changed`. These are not needed for
  the four tools; decide when a client needs them.
- **Exposing workspaces.** Their access belongs to the server (ADR-0009); a later step.
