# MPDM Local Monitor

Runs real MPDM PROD, MPDM DEV, InReality Platform V3, and InReality Platform V3 DEV login checks on a local Mac. A single long-lived Chromium process is reused, and checks run sequentially to reduce startup time and memory usage.

The project also includes a separate public read-only dashboard with a light Apple/iOS-style UI. The monitor itself remains bound to `127.0.0.1`, while the dashboard listens on `0.0.0.0:8788` by default. This keeps the action endpoints and credentials private while allowing LAN or Cloudflare Tunnel access to status data.

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

Each direct site is counted independently. An alert is sent after two consecutive failures, only once for the same incident. A recovery message is sent when that site succeeds again. Alert counters survive service restarts.

## Optional proxy rotation

Proxy monitoring is separate from the normal direct checks. It uses one proxy per cycle and rotates through the configured proxy list in order. By default it runs every 120 minutes and checks only MPDM PROD (`prod`) and InReality V3 PROD (`app`).

Add the following to `.env`:

```dotenv
PROXY_CHECK_INTERVAL_MINUTES=120
PROXY_CHECK_ON_START=false
PROXY_FAILURE_NOTIFICATION_THRESHOLD=1
PROXY_TARGETS=prod,app
PROXY_USERNAME=your-webshare-username
PROXY_PASSWORD=your-webshare-password
PROXY_LIST=US-Seattle=http://proxy1.example.com:8000;JP-Tokyo=http://proxy2.example.com:8000;UK-London-1=http://proxy3.example.com:8000;UK-London-2=http://proxy4.example.com:8000
PROXY_IP_CHECK_URL=https://ipv4.webshare.io/
```

`PROXY_LIST` entries can be plain `host:port` values or `Label=host:port`. Separate entries with semicolons or commas. Put the provider's official location directly in each label, for example `US-Seattle`, `JP-Tokyo`, or `UK-London-1`. If multiple proxies share the same city, append `-1`, `-2`, and so on. Keep proxy credentials only in `.env`; never commit them.

The round-robin position is saved in `data/proxy-state.json`, so restarting the service does not reset rotation to the first proxy. Before each proxy login cycle, the monitor attempts to retrieve the proxy exit IPv4 address and includes it in the result.

Proxy alerts use a shared state per service instead of per proxy. With `PROXY_FAILURE_NOTIFICATION_THRESHOLD=1`, every failing proxy check sends an alert. The next successful proxy check for the same service sends the recovery notification even if it uses a different region.

## Monitor endpoints

The monitor listens on `127.0.0.1:8787` by default. All monitor endpoints require `Authorization: Bearer <MONITOR_TOKEN>`.

```bash
curl -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/health/all
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/run/all
```

- `GET /health/prod`, `/health/dev`, `/health/app`, `/health/app-dev`, `/health/all`: return the latest cached direct result immediately.
- `POST /run/prod`, `/run/dev`, `/run/app`, `/run/app-dev`, `/run/all`: run a fresh direct check and return its result.
- `GET /health/proxy`: return the latest proxy-cycle result and which proxy is next.
- `POST /run/proxy`: immediately run the next configured proxy against `PROXY_TARGETS`, then advance the round-robin position.
- `POST /notify/test`: send a test message to the configured Slack webhook.

All checks are queued instead of running Chromium sessions concurrently. Both InReality V3 environments use the username, Continue, password, Continue login flow. OAuth query parameters are removed from all returned URLs.

## Public read-only dashboard

The dashboard is a separate process. It authenticates to the local monitor internally using `MONITOR_TOKEN`, but does not expose that token or any action endpoint to visitors.

Recommended `.env` settings:

```dotenv
HOST=127.0.0.1
PORT=8787

DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=8788
DASHBOARD_MONITOR_URL=http://127.0.0.1:8787
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
http://127.0.0.1:8788/
```

From another device on the same LAN, use the Mac's LAN IP:

```text
http://<MAC-LAN-IP>:8788/
```

The public dashboard exposes only read-only endpoints:

- `GET /` and `GET /dashboard`: Apple/iOS-style dashboard
- `GET /health/all`: cached direct status copied from the private monitor
- `GET /health/proxy`: cached proxy status copied from the private monitor
- `GET /api/history`: recent direct and proxy results
- `GET /api/meta`: display metadata such as intervals and proxy count

There are intentionally no public `/run/*` or `/notify/test` routes on port `8788`.

Dashboard history is stored in `data/dashboard-history.json` and capped by `DASHBOARD_HISTORY_LIMIT`. It stores status, timestamps, duration, service names, proxy labels/IPs, and failure reasons; it does not store login credentials.

## Start automatically on macOS

After manual testing succeeds:

```bash
chmod +x install-launchd.sh
./install-launchd.sh
```

The installer now creates two user LaunchAgents:

- `com.jeffrey-spectrio.mpdm-local-monitor` — private monitor on `127.0.0.1:8787`
- `com.jeffrey-spectrio.mpdm-local-dashboard` — public read-only dashboard on `0.0.0.0:8788`

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

## Cloudflare Tunnel external access

For Internet access, route only the dashboard port through Cloudflare Tunnel. Do not route the private monitor port `8787`.

Install `cloudflared` on macOS:

```bash
brew install cloudflared
```

Create/login to a locally managed tunnel using Cloudflare's normal CLI flow, then copy `config/cloudflared.yml.example` to `~/.cloudflared/config.yml` and replace:

- `YOUR_TUNNEL_UUID`
- `YOUR_MAC_USER`
- `monitor.example.com`

The important origin line is:

```yaml
service: http://127.0.0.1:8788
```

Create the DNS route:

```bash
cloudflared tunnel route dns <TUNNEL-NAME-OR-UUID> monitor.example.com
```

Test the tunnel:

```bash
cloudflared tunnel run <TUNNEL-NAME-OR-UUID>
```

On macOS, `cloudflared service install` installs it as a user LaunchAgent that starts when you log in. Using `sudo cloudflared service install` installs it as a system LaunchDaemon that starts at boot. See the current Cloudflare Tunnel documentation before installation because service behavior and CLI options can change.

Once configured, the dashboard can be reached externally at:

```text
https://monitor.example.com/
```

## Updating

```bash
git pull --ff-only
npm ci
npx playwright install chromium
./install-launchd.sh
```

Secrets and runtime logs are excluded from Git.
