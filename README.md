# MPDM Local Monitor

Runs real MPDM PROD, MPDM DEV, InReality Platform V3, and InReality Platform V3 DEV login checks on a local Mac. A single long-lived Chromium process is reused, and checks run sequentially to reduce startup time and memory usage.

The project also includes a separate read-only dashboard with a light Apple/iOS-style UI. The monitor itself remains bound to `127.0.0.1:8780`, while the dashboard listens on `0.0.0.0:8781` by default. This keeps the action endpoints and credentials private while allowing LAN access to status data.

## Requirements

- macOS (Apple silicon or Intel)
- Node.js 20 or newer
- A user session that remains logged in when using `launchd`

## Install

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env` with the MPDM PROD, MPDM DEV, InReality V3 PROD, and InReality V3 DEV credentials and a long random `MONITOR_TOKEN`, then test the monitor:

```bash
node --env-file=.env src/index.js
```

Direct checks run at startup and every 15 minutes by default.

To receive Slack alerts, create a Slack incoming webhook and set it in `.env`:

```dotenv
FAILURE_NOTIFICATION_THRESHOLD=2
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Each full monitoring cycle runs the direct network and every configured proxy in parallel. Each network tests all four URLs sequentially. `FAILURE_NOTIFICATION_THRESHOLD` is the number of failed networks allowed before alerting: with `2`, three or more failures send an alert, while two or fewer failures do not. Every cycle above the threshold sends an alert; recovery does not send a separate message.

## Proxy monitoring

Proxy monitoring runs in the same full cycle as direct monitoring. Every configured proxy is tested on every cycle, and every proxy uses the same four-URL login flow as direct monitoring.

Add the following to `.env`:

```dotenv
# Single proxy (use this only when credentials are shared):
# PROXY_URL=http://your-vps-proxy.example.com:8000
# PROXY_USERNAME=your-vps-proxy-username
# PROXY_PASSWORD=your-vps-proxy-password
# Multiple proxies with different credentials. URL-encode special characters.
PROXY_LIST=JP-Tokyo=http://tokyo-user:tokyo%40password@proxy1.example.com:8000;UK-London=http://london-user:london%23password@proxy2.example.com:8000;US-Seattle=http://seattle-user:seattle%40password@proxy3.example.com:8000
# Optional global fallback for list entries without username:password@ in the URL.
# PROXY_USERNAME=your-fallback-username
# PROXY_PASSWORD=your-fallback-password
# Keep false to use the same page-loading behavior as direct checks.
PROXY_BLOCK_NONESSENTIAL=false
```

Set `PROXY_URL` for one proxy, or set `PROXY_LIST` for multiple proxies. Each `PROXY_LIST` entry can contain its own credentials in standard URL form: `Label=http://username:password@host:port`. URL-encode special characters in credentials (`@` → `%40`, `#` → `%23`, etc.). Global `PROXY_USERNAME` and `PROXY_PASSWORD` are only fallbacks for entries without embedded credentials, and all secrets must stay in `.env`.

There is no round-robin skip: every configured proxy runs on every cycle. Direct and proxy networks run in parallel, while each network checks its four URLs sequentially. No extra IP lookup is performed, which keeps proxy execution close to direct execution. Proxy server credentials are redacted from returned results and logs.

Proxy page and login waits use `PROXY_TIMEOUT_MS` (60 seconds by default); direct checks keep their existing timeouts. Increase this value if a proxy is consistently slower, for example `PROXY_TIMEOUT_MS=90000`.

Slack alerts use the combined network failure count. For example, with one direct check and four proxies and `FAILURE_NOTIFICATION_THRESHOLD=2`, three to five failed networks trigger an alert; zero to two failed networks do not. Every cycle that exceeds the threshold sends an alert. The alert is grouped by URL, and each URL lists Direct plus every proxy. Failed entries include their reason, and the check timestamp is shown in UTC+8:

```text
MPDM PROD login check failed
• Direct = Pass
• Proxy: 🇯🇵 JP-Tokyo = Failure
  ↳ Reason: VPS timeout
• Proxy: 🇺🇸 US-Seattle = Pass

MPDM DEV login check passed
• Direct = Pass
• Proxy: 🇯🇵 JP-Tokyo = Pass
• Proxy: 🇺🇸 US-Seattle = Pass
```

## Monitor endpoints

The monitor listens on `127.0.0.1:8780` by default. All monitor endpoints require `Authorization: Bearer <MONITOR_TOKEN>`.

```bash
curl -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8780/health/all
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8780/run/all
```

- `GET /health/prod`, `/health/dev`, `/health/app`, `/health/app-dev`, `/health/all`: return the latest cached direct result immediately.
- `POST /run/prod`, `/run/dev`, `/run/app`, `/run/app-dev`: run a fresh direct check and return its result.
- `POST /run/all`: run a complete direct-plus-all-proxy cycle and return every result.
- `GET /health/proxy`: return the latest complete direct-plus-proxy cycle.
- `POST /run/proxy`: immediately run a complete direct-plus-all-proxy cycle.
- `POST /notify/test`: send a test message to the configured Slack webhook.

All checks are queued instead of running Chromium sessions concurrently. Direct and proxy checks use the same login flow and all four configured URLs. Both InReality V3 environments use the username, Continue, password, Continue login flow. OAuth query parameters are removed from all returned URLs.

## Public read-only dashboard

The dashboard is a separate process. It authenticates to the local monitor internally using `MONITOR_TOKEN`, but does not expose that token or any action endpoint to visitors.

Recommended `.env` settings:

```dotenv
HOST=127.0.0.1
PORT=8780

DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=8781
DASHBOARD_MONITOR_URL=http://127.0.0.1:8780
DASHBOARD_POLL_INTERVAL_SECONDS=30
DASHBOARD_HISTORY_LIMIT=500
DASHBOARD_HISTORY_PATH=data/dashboard-history.json
```

Start the dashboard manually for testing:

```bash
node --env-file=.env src/dashboard-server.js
```

Open it locally:

```text
http://127.0.0.1:8781/
```

From another device on the same LAN, use the Mac's LAN IP:

```text
http://<MAC-LAN-IP>:8781/
```

The public dashboard exposes only read-only endpoints:

- `GET /` and `GET /dashboard`: Apple/iOS-style dashboard
- `GET /health/all`: cached direct status copied from the private monitor
- `GET /health/proxy`: cached proxy status copied from the private monitor
- `GET /api/history`: recent direct and proxy results
- `GET /api/meta`: display metadata such as intervals and proxy count

There are intentionally no public `/run/*` or `/notify/test` routes on port `8781`.

Dashboard history is stored in `data/dashboard-history.json` and capped by `DASHBOARD_HISTORY_LIMIT`. It stores status, timestamps, duration, service names, proxy labels/IPs, and failure reasons; it does not store login credentials.

## Start automatically on macOS

After manual testing succeeds:

```bash
chmod +x install-launchd.sh
./install-launchd.sh
```

The installer now creates two user LaunchAgents:

- `com.jeffrey-spectrio.mpdm-local-monitor` — private monitor on `127.0.0.1:8780`
- `com.jeffrey-spectrio.mpdm-local-dashboard` — public read-only dashboard on `0.0.0.0:8781`

Both start after login and restart after a crash.

Check them with:

```bash
launchctl print gui/$(id -u)/com.jeffrey-spectrio.mpdm-local-monitor
launchctl print gui/$(id -u)/com.jeffrey-spectrio.mpdm-local-dashboard
```

Logs:

```bash
tail -f monitor.log
tail -f dashboard.log
```

## Updating

```bash
git pull --ff-only
npm ci
npx playwright install chromium
./install-launchd.sh
```

Secrets and runtime logs are excluded from Git.
