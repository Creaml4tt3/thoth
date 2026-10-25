Recorded Claude Code 2.1.310 output, 2026-10-25 (see ../../README.md):

- `help-2.1.310.txt`: `claude --help`, verbatim.
- `stream-edit.jsonl`: one real `-p --output-format stream-json --verbose` run with the adapter's flags and
  `--model haiku` (edit a file, a read outside the working directory denied by `--restricted`). Session IDs,
  UUIDs, message IDs, the thinking signature, usage details and the temp path are replaced; the shapes are as
  recorded.
- `stream-not-logged-in.jsonl`: the same flags with an empty `CLAUDE_CONFIG_DIR` (no login), exit code 1. The
  assistant text block is reconstructed from the recorded `result`.
- `stream-model-not-found.jsonl`: the same flags with an unknown `--model`, exit code 1, cost 0.
- `argv.json`: the argument lists the adapter builds; checked by the TS tests and the Rust host's policy tests.
