Recorded Codex CLI 0.164.0 output, 2026-10-25 (see ../../README.md, "Real runs"):

- `help-exec-0.164.0.txt`: `codex exec --help`, verbatim.
- `stream-edit.jsonl`: a real `codex exec --json` run with the adapter's flags (the read rule of that run also named
  the CLI's install folder) and `-m gpt-5.6-luna`: a shell command, an `apply_patch` edit (`file_change`), the agent's
  messages, `turn.completed` with token usage.
- `stream-shell-edit.jsonl`: the first real run (started through the Homebrew link, so `apply_patch` could not run
  in the sandbox and the edit was made with `sed`); a `curl` that failed with no network (exit code 6).
- `stream-model-not-found.jsonl`: `-m thoth-no-such-model`: an `error` item about unknown model metadata, then
  `turn.failed` with the API's `model_not_found` error; exit code 1.
- `stream-not-logged-in.jsonl`: `CODEX_HOME` set to an empty folder (no login read or used): reconnects with 401,
  then `turn.failed`; exit code 1.
- `argv.json`: the argument lists the adapter builds; checked by the TS tests and the Rust host's policy tests.

Sanitised: thread IDs, the working directory (`/RUN/work`), Cloudflare ray IDs and request IDs are replaced; the
shapes and everything else are as recorded.
