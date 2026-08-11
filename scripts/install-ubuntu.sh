#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--sudo-stdin" ]]; then
  IFS= read -r SUDO_PASSWORD
fi

sudo_run() {
  if sudo -n true 2>/dev/null; then
    sudo "$@"
  elif [[ -n "${SUDO_PASSWORD:-}" ]]; then
    printf '%s\n' "$SUDO_PASSWORD" | sudo -S -p '' "$@"
  else
    sudo "$@"
  fi
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SHARED_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
INSTALL_ROOT="$HOME/.local/share/rhzycode-linux"
SOURCE_ROOT="$INSTALL_ROOT/source"
TOOLS_ROOT="$INSTALL_ROOT/tools"
CONFIG_ROOT="$HOME/.config/rhzycode"
GATEWAY_ROOT="$CONFIG_ROOT/gateway"
CODEX_HOME="$CONFIG_ROOT/codex-home"

case "$SOURCE_ROOT" in
  "$HOME/.local/share/rhzycode-linux/source") ;;
  *) printf 'Refusing unsafe staging path: %s\n' "$SOURCE_ROOT" >&2; exit 1 ;;
esac

printf '[1/6] Installing Ubuntu runtime dependencies...\n'
sudo_run dpkg --configure -a
sudo_run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo_run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  rsync libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libnotify4 libsecret-1-0 \
  libxss1 libxtst6 xdg-utils fakeroot

printf '[2/6] Staging the shared source tree locally...\n'
mkdir -p "$SOURCE_ROOT" "$TOOLS_ROOT" "$GATEWAY_ROOT" "$CODEX_HOME"
rsync -a --delete \
  --exclude '/.git/' \
  --exclude '/node_modules/' \
  --exclude '/desktop/release/' \
  --exclude '/mobile/android/' \
  --exclude '/mobile/modules/update-installer/android/' \
  --exclude 'build/' \
  --exclude '/.tmp-*' \
  "$SHARED_ROOT/" "$SOURCE_ROOT/"
[[ ! -f "$SOURCE_ROOT/desktop/.env" ]] || chmod 600 "$SOURCE_ROOT/desktop/.env"

printf '[3/6] Installing Linux dependencies and the pinned Codex CLI...\n'
cd "$SOURCE_ROOT"
npm ci --no-audit --no-fund
sudo_run chown root:root "$SOURCE_ROOT/node_modules/electron/dist/chrome-sandbox"
sudo_run chmod 4755 "$SOURCE_ROOT/node_modules/electron/dist/chrome-sandbox"
CODEX_VERSION="$(node -p "require('./desktop/codex-version.json').cli")"
npm install --prefix "$TOOLS_ROOT" --no-audit --no-fund "@openai/codex@$CODEX_VERSION"
CODEX_WRAPPER="$TOOLS_ROOT/node_modules/.bin/codex"
"$CODEX_WRAPPER" --version
CODEX_NATIVE="$(find "$TOOLS_ROOT/node_modules" -type f \( \
  -path '*/vendor/*/bin/codex' -o -path '*/vendor/*/codex/codex' \
\) -print -quit)"
if [[ -z "$CODEX_NATIVE" ]]; then
  printf 'Unable to locate the native Codex binary installed by @openai/codex.\n' >&2
  exit 1
fi
chmod u+x "$CODEX_NATIVE"

printf '[4/6] Building AppImage and deb packages...\n'
RHZYCODE_CODEX_PATH="$CODEX_NATIVE" npm run dist:linux
DEB_PATH="$(find "$SOURCE_ROOT/desktop/release" -maxdepth 1 -type f -name '*.deb' -print | sort | tail -n 1)"
if [[ -z "$DEB_PATH" ]]; then
  printf 'Linux deb package was not generated.\n' >&2
  exit 1
fi

printf '[5/6] Installing RHZYCODE...\n'
sudo_run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$DEB_PATH"
cp "$SOURCE_ROOT/desktop/gateway.config.json" "$GATEWAY_ROOT/gateway.config.json"
cp "$SOURCE_ROOT/desktop/codex-model-catalog.json" "$GATEWAY_ROOT/codex-model-catalog.json"
cp "$SOURCE_ROOT/desktop/model-context-windows.json" "$GATEWAY_ROOT/model-context-windows.json"

mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
cat > "$HOME/.local/bin/rhzycode" <<EOF
#!/usr/bin/env bash
set -a
[[ ! -f "$CONFIG_ROOT/provider.env" ]] || source "$CONFIG_ROOT/provider.env"
set +a
export RHZYCODE_GATEWAY_HOME="$GATEWAY_ROOT"
export RHZYCODE_CODEX_HOME="$CODEX_HOME"
export RHZYCODE_OZONE_PLATFORM="\${RHZYCODE_OZONE_PLATFORM:-x11}"
export ELECTRON_OZONE_PLATFORM_HINT="\$RHZYCODE_OZONE_PLATFORM"
exec /opt/RHZYCODE/rhzycode "--ozone-platform=\$RHZYCODE_OZONE_PLATFORM" "\$@"
EOF
chmod 755 "$HOME/.local/bin/rhzycode"

cat > "$HOME/.local/share/applications/rhzycode.desktop" <<EOF
[Desktop Entry]
Name=RHZYCODE
Comment=Cross-platform coding agent
Exec=$HOME/.local/bin/rhzycode %U
Terminal=false
Type=Application
Icon=rhzycode
Categories=Development;
StartupNotify=true
EOF
chmod 644 "$HOME/.local/share/applications/rhzycode.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

printf '[6/6] Installation complete.\n'
printf 'deb=%s\n' "$DEB_PATH"
printf 'appimage=%s\n' "$(find "$SOURCE_ROOT/desktop/release" -maxdepth 1 -type f -name '*.AppImage' -print | sort | tail -n 1)"
printf 'launcher=%s\n' "$HOME/.local/bin/rhzycode"
