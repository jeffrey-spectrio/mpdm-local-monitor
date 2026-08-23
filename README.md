# MPDM Local Monitor

Runs real MPDM PROD, MPDM DEV, InReality Platform V3, and InReality Platform V3 DEV login checks on a local Mac. A single long-lived Chromium process is reused, and checks run sequentially to reduce startup time and memory usage.

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

Edit `.env` with the MPDM PROD, MPDM DEV, InReality V3 PROD, and InReality V3 DEV credentials and a long random `MONITOR_TOKEN`, then test:

```bash
node --env-file=.env src/index.js
```

The service listens on `127.0.0.1:8787` by default. Direct checks run at startup and every 15 minutes.

To receive Slack alerts, create a Slack incoming webhook and set it in `.env`:

```dotenv
FAILURE_NOTIFICATION_THRESHOLD=2
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Each site is counted independently. An alert is sent after two consecutive failures, only once for the same incident. A recovery message is sent when that site succeeds again. Alert counters survive service restarts.

## Optional proxy rotation

Proxy monitoring is separate from the normal direct checks. It uses one proxy per cycle and rotates through the configured proxy list in order. By default it runs every 120 minutes and checks only MPDM PROD (`prod`) and InReality V3 PROD (`app`).

Add the following to `.env`:

```dotenv
PROXY_CHECK_INTERVAL_MINUTES=120
PROXY_CHECK_ON_START=false
PROXY_TARGETS=prod,app
PROXY_USERNAME=your-webshare-username
PROXY_PASSWORD=your-webshare-password
PROXY_LIST=US-Seattle=http://proxy1.example.com:8000;JP-Tokyo=http://proxy2.example.com:8000;UK-London-1=http://proxy3.example.com:8000;UK-London-2=http://proxy4.example.com:8000
PROXY_IP_CHECK_URL=https://ipv4.webshare.io/
```

`PROXY_LIST` entries can be plain `host:port` values or `Label=host:port`. Separate entries with semicolons or commas. For Webshare, put the official Webshare location directly in the label, for example `US-Seattle`, `JP-Tokyo`, or `UK-London-1`. If multiple proxies share the same city, append `-1`, `-2`, and so on. The label is returned as `proxyLabel` in `/run/proxy` and `/health/proxy`, and is also included in proxy Slack alerts, so no separate IP geolocation request is required. Keep proxy credentials only in `.env`; never commit them.

The round-robin position is saved in `data/proxy-state.json`, so restarting the service does not reset rotation to the first proxy. Before each proxy login cycle, the monitor attempts to retrieve the proxy exit IPv4 address and includes it in the result.

## Endpoints

All monitor endpoints require `Authorization: Bearer <MONITOR_TOKEN>`.

```bash
curl -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/health/all
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/run/all
```

- `GET /health/prod`, `/health/dev`, `/health/app`, `/health/app-dev`, `/health/all`: return the latest cached direct result immediately.
- `POST /run/prod`, `/run/dev`, `/run/app`, `/run/app-dev`, `/run/all`: run a fresh direct check and return its result.
- `GET /health/proxy`: return the latest proxy-cycle result and which proxy is next.
- `POST /run/proxy`: immediately run the next configured proxy against `PROXY_TARGETS`, then advance the round-robin position.
- `POST /notify/test`: send a test message to the configured Slack webhook.

All checks are queued instead of running Chromium sessions concurrently. Both InReality V3 environments use the username, Continue, password, Continue login flow. PROD only succeeds at `https://app.inreality.com/v3/auth0/`; DEV only succeeds at `https://v3-dev.inreality.com/v3/auth0/`. OAuth query parameters are removed from all returned URLs.

Test Slack after restarting the service:

```bash
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/notify/test
```

Test one proxy cycle manually:

```bash
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/run/proxy
```

Then inspect the cached proxy result:

```bash
curl -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/health/proxy
```

## Start automatically on macOS

After the manual test succeeds:

```bash
chmod +x install-launchd.sh
./install-launchd.sh
```

The installer creates a user LaunchAgent that starts after login, restarts after a crash, and writes logs in the project directory.

## Remote access

The default bind address is local-only. Keep it that way unless access is provided through a protected Cloudflare Tunnel or Tailscale connection. Do not expose the port directly to the internet.

## Updating

```bash
git pull --ff-only
npm ci
npx playwright install chromium
./install-launchd.sh
```

Secrets and runtime logs are excluded from Git.
