#!/usr/bin/env bash
# Runs server admin CLI commands against the production database (docs/deploy/trial.md §1 step 3).
#
#   scripts/prod-db.sh migrate backfill-kind
#
# The Neon *direct* connection URL is asked for in a private macOS dialog (hidden input). It is kept only in this
# process's memory and passed to the CLI through the environment: it is never written to disk, never on a command
# line, never echoed, and it is redacted from any output. Nothing is stored for next time.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/prod-db.sh <cli command>... (for example: migrate backfill-kind)" >&2
  exit 2
fi
for cmd in "$@"; do
  case "$cmd" in
    migrate | backfill-kind) ;;
    *) echo "refused: '$cmd' is not an allowed command here (migrate, backfill-kind)" >&2; exit 2 ;;
  esac
done

if ! url=$(osascript \
  -e 'tell application "System Events" to activate' \
  -e 'tell application "System Events" to text returned of (display dialog "Paste the Neon DIRECT connection URL (pooling off). It stays on this Mac, is used once and is not saved." default answer "" with hidden answer with title "Thoth: production database" buttons {"Cancel", "Run"} default button "Run" cancel button "Cancel")' 2>/dev/null); then
  echo "cancelled: no URL entered, nothing ran" >&2
  exit 1
fi

case "$url" in
  postgres://* | postgresql://*) ;;
  *) url=""; echo "refused: that does not look like a postgres:// URL; nothing ran" >&2; exit 1 ;;
esac
case "$url" in
  *-pooler.*) url=""; echo "refused: that is the pooled URL (host contains -pooler); migrations need the direct URL" >&2; exit 1 ;;
esac

redact() {
  local line
  while IFS= read -r line; do printf '%s\n' "${line//"$url"/[redacted]}"; done
}

status=0
for cmd in "$@"; do
  echo "== $cmd"
  if ! DATABASE_URL="$url" node apps/server/src/cli.ts "$cmd" 2>&1 | redact; then
    status=1
    break
  fi
  # pipefail: the pipeline fails when the CLI fails.
done
url=""
exit "$status"
