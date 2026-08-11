#!/usr/bin/env bash
set -euo pipefail

runtime_directory="/run/user/$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$runtime_directory}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$runtime_directory/bus}"
export DISPLAY="${DISPLAY:-:0}"
export RHZYCODE_OZONE_PLATFORM="${RHZYCODE_OZONE_PLATFORM:-x11}"
export ELECTRON_OZONE_PLATFORM_HINT="$RHZYCODE_OZONE_PLATFORM"

if [[ -z "${XAUTHORITY:-}" ]]; then
  XAUTHORITY="$(find "$runtime_directory" -maxdepth 1 -type f -name '.mutter-Xwaylandauth.*' -print -quit 2>/dev/null || true)"
  [[ -z "$XAUTHORITY" ]] || export XAUTHORITY
fi

log_path="$HOME/.local/share/rhzycode-linux/app.log"
mkdir -p "$(dirname "$log_path")"
nohup "$HOME/.local/bin/rhzycode" > "$log_path" 2>&1 < /dev/null &
printf 'pid=%s\nlog=%s\n' "$!" "$log_path"
