#!/bin/zsh
set -euo pipefail

PROJECT_PATH="${0:A:h}"
NODE_PATH="$(command -v node)"
MONITOR_TEMPLATE="$PROJECT_PATH/config/com.jeffrey-spectrio.mpdm-local-monitor.plist.template"
DASHBOARD_TEMPLATE="$PROJECT_PATH/config/com.jeffrey-spectrio.mpdm-local-dashboard.plist.template"
MONITOR_PLIST="$HOME/Library/LaunchAgents/com.jeffrey-spectrio.mpdm-local-monitor.plist"
DASHBOARD_PLIST="$HOME/Library/LaunchAgents/com.jeffrey-spectrio.mpdm-local-dashboard.plist"
LAUNCH_DOMAIN="gui/$(id -u)"

if [[ ! -f "$PROJECT_PATH/.env" ]]; then
  echo "Missing $PROJECT_PATH/.env. Copy .env.example and add the credentials first."
  exit 1
fi

stop_agent() {
  local label="$1"

  if ! launchctl print "$LAUNCH_DOMAIN/$label" >/dev/null 2>&1; then
    return 0
  fi
  launchctl bootout "$LAUNCH_DOMAIN/$label" 2>/dev/null || true
  for attempt in {1..20}; do
    if ! launchctl print "$LAUNCH_DOMAIN/$label" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for $label to stop. Check: launchctl print $LAUNCH_DOMAIN/$label" >&2
  return 1
}

install_agent() {
  local label="$1"
  local template="$2"
  local plist="$3"

  sed -e "s|__NODE_PATH__|$NODE_PATH|g" -e "s|__PROJECT_PATH__|$PROJECT_PATH|g" "$template" > "$plist"
  plutil -lint "$plist"
}

mkdir -p "$HOME/Library/LaunchAgents"
MONITOR_LABEL="com.jeffrey-spectrio.mpdm-local-monitor"
DASHBOARD_LABEL="com.jeffrey-spectrio.mpdm-local-dashboard"
stop_agent "$MONITOR_LABEL"
stop_agent "$DASHBOARD_LABEL"
install_agent "$MONITOR_LABEL" "$MONITOR_TEMPLATE" "$MONITOR_PLIST"
install_agent "$DASHBOARD_LABEL" "$DASHBOARD_TEMPLATE" "$DASHBOARD_PLIST"
launchctl bootstrap "$LAUNCH_DOMAIN" "$MONITOR_PLIST"
launchctl bootstrap "$LAUNCH_DOMAIN" "$DASHBOARD_PLIST"
launchctl enable "$LAUNCH_DOMAIN/$MONITOR_LABEL"
launchctl enable "$LAUNCH_DOMAIN/$DASHBOARD_LABEL"
launchctl kickstart -k "$LAUNCH_DOMAIN/$MONITOR_LABEL"
launchctl kickstart -k "$LAUNCH_DOMAIN/$DASHBOARD_LABEL"

echo "MPDM Local Monitor and public read-only dashboard installed and started."
