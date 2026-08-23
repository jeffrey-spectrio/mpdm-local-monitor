#!/bin/zsh
set -euo pipefail

PROJECT_PATH="${0:A:h}"
NODE_PATH="$(command -v node)"
MONITOR_TEMPLATE="$PROJECT_PATH/config/com.jeffrey-spectrio.mpdm-local-monitor.plist.template"
DASHBOARD_TEMPLATE="$PROJECT_PATH/config/com.jeffrey-spectrio.mpdm-local-dashboard.plist.template"
MONITOR_PLIST="$HOME/Library/LaunchAgents/com.jeffrey-spectrio.mpdm-local-monitor.plist"
DASHBOARD_PLIST="$HOME/Library/LaunchAgents/com.jeffrey-spectrio.mpdm-local-dashboard.plist"

if [[ ! -f "$PROJECT_PATH/.env" ]]; then
  echo "Missing $PROJECT_PATH/.env. Copy .env.example and add the credentials first."
  exit 1
fi

install_agent() {
  local label="$1"
  local template="$2"
  local plist="$3"

  sed -e "s|__NODE_PATH__|$NODE_PATH|g" -e "s|__PROJECT_PATH__|$PROJECT_PATH|g" "$template" > "$plist"
  plutil -lint "$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/$label"
  launchctl kickstart -k "gui/$(id -u)/$label"
}

mkdir -p "$HOME/Library/LaunchAgents"
install_agent "com.jeffrey-spectrio.mpdm-local-monitor" "$MONITOR_TEMPLATE" "$MONITOR_PLIST"
install_agent "com.jeffrey-spectrio.mpdm-local-dashboard" "$DASHBOARD_TEMPLATE" "$DASHBOARD_PLIST"

echo "MPDM Local Monitor and public read-only dashboard installed and started."
