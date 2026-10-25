/**
 * The Codex CLI command line for one Agent Hub run (`codex exec`). Every flag and every `-c` key here was checked on
 * 2026-10-25 against Codex CLI 0.164.0 (`codex exec --help`, `--strict-config`, which refuses an unknown `-c` key) and
 * the official docs (README.md lists each with its source). The prompt is not an argument: `codex exec` reads it from
 * stdin when no prompt argument is given.
 *
 * Codex's main tool runs shell commands, so unlike Claude Code the shell cannot be taken away. Instead every command
 * (and Codex's own file edits) runs inside Codex's own OS sandbox under a permission profile, `thoth`, that may read
 * only the platform's runtime paths (`:minimal`) and the working directory, write only the working directory, never
 * `/tmp` or `$TMPDIR`, and has no network. Approvals never prompt (there is nobody to answer): anything outside the
 * sandbox is refused, never escalated.
 *
 * Every value is written without quotes or braces (Codex parses a value that is not TOML as a plain string), so the
 * same list is safe through Windows' `cmd.exe` launchers. The Rust host accepts only this exact list
 * (`crates/thoth-host/src/agent/codex.rs`); `test/fixtures/argv.json` is checked by both sides.
 */

/** The permission profile Thoth defines for every run (Codex calls profiles by name; this one is ours). */
export const PROFILE = "thoth";

/** `-c key=value` overrides, in order. */
export const CONFIG: readonly string[] = [
  // Non-interactive: never ask (nobody can answer); a command that needs more than the sandbox allows just fails.
  "approval_policy=never",
  "approvals_reviewer=user",
  // The sandbox: a permission profile that reads only runtime paths and the working directory, writes only the
  // working directory, never /tmp or $TMPDIR, and has no network.
  `default_permissions=${PROFILE}`,
  `permissions.${PROFILE}.filesystem.:minimal=read`,
  `permissions.${PROFILE}.filesystem.:workspace_roots=write`,
  `permissions.${PROFILE}.filesystem.:slash_tmp=deny`,
  `permissions.${PROFILE}.filesystem.:tmpdir=deny`,
  `permissions.${PROFILE}.network.enabled=false`,
  // If a system or managed config forces the older sandbox settings instead of profiles, they too have no network
  // and no temp folders.
  "sandbox_workspace_write.network_access=false",
  "sandbox_workspace_write.exclude_slash_tmp=true",
  "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  // No web search tool.
  "web_search=disabled",
  // The working directory is the project root (no walking up to a parent git repo), and no AGENTS.md is read from it.
  "project_root_markers=[]",
  "project_doc_max_bytes=0",
  // Nothing added to the user's history; commands get only a core environment.
  "history.persistence=none",
  "shell_environment_policy.inherit=core",
  // No sub-agents, connectors, plugins, hooks, memories, image generation, browser or computer use.
  "agents.enabled=false",
  "features.apps=false",
  "features.plugins=false",
  "features.multi_agent=false",
  "features.hooks=false",
  "features.memories=false",
  "features.image_generation=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.skill_mcp_dependency_install=false",
  "check_for_update_on_startup=false",
];

export interface CodexRunOptions {
  model?: string;
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** A model slug such as `gpt-5.5`; never starts with `-`. */
export function isModelName(name: string): boolean {
  return MODEL.test(name);
}

export function buildArgs(options: CodexRunOptions = {}): string[] {
  const args = [
    "exec",
    // JSON Lines events on stdout.
    "--json",
    "--color",
    "never",
    // No session files on disk.
    "--ephemeral",
    // The working directory is a fresh folder, not a git repository.
    "--skip-git-repo-check",
    // Not the user's config.toml (its MCP servers, profiles, sandbox or approval settings) nor their .rules files;
    // the login still comes from CODEX_HOME.
    "--ignore-user-config",
    "--ignore-rules",
    // An unknown key in a -c override is an error, so a renamed setting fails the run instead of being ignored.
    "--strict-config",
  ];
  for (const entry of CONFIG) args.push("-c", entry);
  if (options.model !== undefined && options.model !== "") {
    if (!isModelName(options.model)) throw new RangeError("That is not a model name Codex accepts");
    args.push("-m", options.model);
  }
  return args;
}
