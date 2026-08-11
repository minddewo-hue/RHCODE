#!/usr/bin/env bash
set -euo pipefail

SHARED_ROOT="/mnt/hgfs/ubuntu_work_space/RHZYCODE"
SOURCE_ROOT="$HOME/.local/share/rhzycode-linux/source"
CONFIG_ROOT="$HOME/.config/rhzycode"
CODEX_NATIVE="$(find "$HOME/.local/share/rhzycode-linux/tools/node_modules" -type f \( \
  -path '*/vendor/*/bin/codex' -o -path '*/vendor/*/codex/codex' \
\) -print -quit)"

if [[ -z "$CODEX_NATIVE" ]]; then
  printf 'The pinned native Codex binary is missing.\n' >&2
  exit 1
fi

runtime_directory="/run/user/$(id -u)"
export XDG_RUNTIME_DIR="$runtime_directory"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus"
export DISPLAY="${DISPLAY:-:0}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export RHZYCODE_CODEX_PATH="$CODEX_NATIVE"
export RHZYCODE_TASK_GATEWAY_HOME="$CONFIG_ROOT/gateway"

if [[ -z "${XAUTHORITY:-}" ]]; then
  XAUTHORITY="$(find "$runtime_directory" -maxdepth 1 -type f -name '.mutter-Xwaylandauth.*' -print -quit 2>/dev/null || true)"
  [[ -z "$XAUTHORITY" ]] || export XAUTHORITY
fi

source "$CONFIG_ROOT/provider.env"
cp "$SHARED_ROOT/desktop/scripts/desktop-task-driver.mjs" "$SOURCE_ROOT/desktop/scripts/desktop-task-driver.mjs"

cd "$SOURCE_ROOT"
node desktop/scripts/desktop-task-driver.mjs \
  --project "$SHARED_ROOT/examples/ubuntu-snake" \
  --prompt-file "$SHARED_ROOT/examples/ubuntu-snake/TASK.md" \
  --model "provider-5/gpt-5.6-sol" \
  --sandbox "danger-full-access" \
  --timeout-minutes "20"
