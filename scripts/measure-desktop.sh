#!/usr/bin/env bash
# Measures a built Thoth.app on macOS: size, cold start and idle use. One line per metric: `name value unit`.
#
#   scripts/measure-desktop.sh target/release/bundle/macos/Thoth.app
#
# The app is launched for real (5 cold starts, then one idle run) and quit afterwards. The window check needs the
# terminal to have Accessibility permission (System Settings > Privacy & Security > Accessibility).
# The binary inside the bundle is thoth-desktop (the Cargo package name), and that is the process name.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -ne 1 ] || [ ! -d "$1/Contents/MacOS" ]; then
  echo "usage: scripts/measure-desktop.sh <path to Thoth.app>" >&2
  exit 2
fi
app=$(cd "$1" && pwd)
dmg=$(ls "$(dirname "$app")"/../dmg/*.dmg 2>/dev/null | head -1 || true)

median() { sort -n | awk '{ v[NR] = $1 } END { print (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2 }'; }
now() { python3 -c 'import time; print(time.time())'; }
quit_app() {
  pkill -x thoth-desktop || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x thoth-desktop >/dev/null || return 0; sleep 1; done
  pkill -9 -x thoth-desktop || true
  sleep 1
}
trap quit_app EXIT

if pgrep -x thoth-desktop >/dev/null; then echo "Thoth is already running: quit it first" >&2; exit 1; fi

echo "app_size $(du -sk "$app" | cut -f1) KB"
if [ -n "$dmg" ]; then echo "dmg_size $(du -sk "$dmg" | cut -f1) KB"; else echo "dmg_size n/a KB"; fi

starts=()
for _ in 1 2 3 4 5; do
  t0=$(now)
  "$app/Contents/MacOS/thoth-desktop" >/dev/null 2>&1 &
  disown
  until osascript -e 'tell application "System Events" to exists window 1 of process "thoth-desktop"' 2>/dev/null | grep -q true; do
    if [ "$(echo "$(now) - $t0 > 60" | bc)" = 1 ]; then echo "no window after 60 s" >&2; exit 1; fi
  done
  starts+=("$(echo "$(now) - $t0" | bc)")
  quit_app
done
echo "cold_start $(printf '%s\n' "${starts[@]}" | median | awk '{ printf "%.3f", $1 }') s"

"$app/Contents/MacOS/thoth-desktop" >/dev/null 2>&1 &
pid=$!
disown
sleep 30
cpu=(); rss=()
for _ in 1 2 3 4 5 6 7 8 9 10; do
  # The host process only: macOS runs the webview's WebContent process outside it, so this is the host's share.
  read -r c r < <(ps -o %cpu=,rss= -p "$pid")
  cpu+=("$c"); rss+=("$r")
  sleep 1
done
echo "idle_cpu $(printf '%s\n' "${cpu[@]}" | median) %"
echo "idle_rss $(printf '%s\n' "${rss[@]}" | median | awk '{ printf "%.1f", $1 / 1024 }') MB"
