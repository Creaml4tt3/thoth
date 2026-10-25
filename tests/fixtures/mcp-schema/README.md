# MCP JSON schemas

The official JSON Schemas of the Model Context Protocol, copied unchanged from
`schema/<version>/schema.json` in
[modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)
at commit `dae694f61a31f7a3ec2af3aff709e11f70f61e48` (main, 2026-10-26). The MCP
specification is licensed under Apache-2.0 (earlier contributions under MIT); see
that repository's `LICENSE`.

| File | Protocol version |
|---|---|
| `2026-07-28.json` | 2026-07-28, the current version (per-request `_meta`, `server/discover`) |
| `2025-11-25.json` | 2025-11-25, the last version with the `initialize` handshake |

`tests/mcp/schema.test.ts` checks every answer of `thoth-mcp` (ADR-0021) against
them. Replace a file only with the same file of a newer commit, and say which.
