# ADR-0007: Agent adapter contract and execution security

- **Status:** Proposed (phase P4)
- **Date:** 2026-10-20

## Context

The Agent Hub drives AI CLI tools the user already owns (Claude Code CLI, Codex
CLI); there is no required Thoth AI subscription (spec section 2). The Agent Hub
is a control surface, not a content store (section 3.3). A prompt is not a
security sandbox, agent output is untrusted, and Thoth must not scrape provider
credentials (sections 10, 12). CLI interfaces change over time and must not be
guessed.

## Decision

1. **Contract.** The `AgentProvider` interface from spec section 10 lives in
   `packages/agent-core`. Adapters are `packages/agent-claude` and
   `packages/agent-codex`. The Claude Code CLI adapter is built end-to-end first,
   then Codex.
2. **No invented CLI details.** CLI flags and output formats are verified against
   the installed CLI's official documentation and `--help` at implementation time.
   Capabilities are detected, not assumed.
3. **Credentials.** Thoth uses the user's existing CLI login and never reads or
   copies provider credentials. Thoth-owned secrets are stored in the OS
   credential store.
4. **Execution scope.** A task runs in a scoped temporary working directory that
   contains copies of only the user-selected pages and folders.
5. **Review before apply.** Proposed changes are diffed against the originals and
   applied to managed notes only after explicit user review, through the same
   compare-and-swap write path as other writes (ADR-0001). Agent output is
   untrusted input.
6. **Sandboxing.** Prompts are not a sandbox. OS-level sandboxing is used where
   available; per-platform feasibility is an open question.
7. **Agent Hub data.** It stores task and run metadata (provider, task, selected
   context, changed files, approvals, outcome). It is not a content store.

## Consequences

- Positive: agents never touch live notes directly; a stale or concurrent edit is
  caught by the existing CAS rule.
- Positive: no credential handling surface in Thoth.
- Negative: copying context into a temp directory costs disk and time and means
  agents cannot see unselected linked pages.
- Negative: without OS sandboxing, an agent process still has the user's OS
  permissions; the temp directory limits intent, not capability.
- Follow-up: detection of installation status with actionable messages;
  cleanup of temp directories after runs; audit of approvals.

## Alternatives considered

- **Run the agent directly in the vault.** Rejected: live notes could change
  without review.
- **Thoth-hosted or API-key-based AI.** Out of scope; locked decision is
  user-owned CLI tools.
- **Prompt-only restrictions as protection.** Rejected: not a security boundary.
- **Both providers in parallel.** Rejected in favor of one provider end-to-end
  first (spec section 10).

## Spec references

Section 2 (agent integration), 3.3, 4, 10, 12, 13 (P4), 14 (steps 9-10), 15
step 7.

## Open questions

- OS-level sandboxing options per platform (macOS, Windows, Linux).
- Whether a temporary git worktree is used instead of a plain temp directory when
  the vault is a git repository (spec says "where practical").
- Handling of Workspace content as agent context (requires export permission
  checks, ADR-0009).
- Exact capability detection mechanism per CLI.
