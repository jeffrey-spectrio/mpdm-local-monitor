#!/bin/zsh
set -euo pipefail

PROJECT_PATH="${0:A:h}"
NODE_PATH="$(command -v node)"
TEMPLATE_PATH="$PROJECT_PATH/config/com.jeffrey-spectrio.mpdm-local-monitor.plist.template"
PLIST_PATH="$HOME/Library/LaunchAgents/com.jeffrey-spectrio.mpdm-local-monitor.plist"

if [[ ! -f "$PROJECT_PATH/.env" ]]; then
  echo "Missing $PROJECT_PATH/.env. Copy .env.example and add the credentials first."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__NODE_PATH__|$NODE_PATH|g" -e "s|__PROJECT_PATH__|$PROJECT_PATH|g" "$TEMPLATE_PATH" > "$PLIST_PATH"
plutil -lint "$PLIST_PATH"
launchctl bootout "gui/$(id -u)/com.jeffrey-spectrio.mpdm-local-monitor" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/com.jeffrey-spectrio.mpdm-local-monitor"
launchctl kickstart -k "gui/$(id -u)/com.jeffrey-spectrio.mpdm-local-monitor"
echo "MPDM Local Monitor installed and started."
