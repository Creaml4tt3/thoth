#!/usr/bin/env bash
# Measures a built Thoth.app on macOS: size, cold start and idle use. One line per metric: `name value unit`.
#
#   scripts/measure-desktop.sh target/release/bundle/macos/Thoth.app
#
# The app is launched for real (5 cold starts, then one idle run) and the process this script launched is killed
# afterwards; no other Thoth is touched. The window check needs the terminal to have Accessibility permission
# (System Settings > Privacy & Security > Accessibility). The binary inside the bundle is thoth-desktop (the Cargo
# package name), and that is the process name.
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
# Cumulative CPU seconds of a process: `ps -o time=` has centiseconds on macOS ([[dd-]hh:]mm:ss.cc).
cpu_seconds() { ps -o time= -p "$1" | awk '{ n = split($1, p, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + p[i]; print s }'; }

# Only ever the PID this script launched, so a dev build or the person's own Thoth is never hit.
pid=""
quit_app() {
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null || true
  pid=""
}
launch() {
  "$app/Contents/MacOS/thoth-desktop" >/dev/null 2>&1 &
  pid=$!
  disown
}

if pgrep -x thoth-desktop >/dev/null; then echo "Thoth is already running: quit it first" >&2; exit 1; fi
trap quit_app EXIT

echo "app_size $(du -sk "$app" | cut -f1) KB"
if [ -n "$dmg" ]; then echo "dmg_size $(du -sk "$dmg" | cut -f1) KB"; else echo "dmg_size n/a KB"; fi

starts=()
for _ in 1 2 3 4 5; do
  t0=$(now)
  launch
  until osascript -e 'tell application "System Events" to exists window 1 of process "thoth-desktop"' 2>/dev/null | grep -q true; do
    kill -0 "$pid" 2>/dev/null || { echo "Thoth exited before it showed a window" >&2; exit 1; }
    if [ "$(echo "$(now) - $t0 > 60" | bc)" = 1 ]; then
      echo "no window after 60 s (does this terminal have Accessibility permission?)" >&2; exit 1
    fi
    sleep 0.05
  done
  starts+=("$(echo "$(now) - $t0" | bc)")
  quit_app
done
echo "cold_start $(printf '%s\n' "${starts[@]}" | median | awk '{ printf "%.3f", $1 }') s"

launch
sleep 30
# Idle CPU is the CPU time used over a 10 s window; RSS is sampled once a second inside the same window. Host
# process only: macOS runs the webview's WebContent process outside it.
cpu0=$(cpu_seconds "$pid")
rss=()
for _ in 1 2 3 4 5 6 7 8 9 10; do
  rss+=("$(ps -o rss= -p "$pid" | tr -d ' ')")
  sleep 1
done
cpu1=$(cpu_seconds "$pid")
echo "idle_cpu $(echo "$cpu0 $cpu1" | awk '{ printf "%.2f", ($2 - $1) / 10 * 100 }') %"
echo "idle_rss $(printf '%s\n' "${rss[@]}" | median | awk '{ printf "%.1f", $1 / 1024 }') MB"
