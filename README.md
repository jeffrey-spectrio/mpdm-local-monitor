# MPDM Local Monitor

Runs real PROD and DEV MPDM login checks on a local Mac. A single long-lived Chromium process is reused, and checks run sequentially to reduce startup time and memory usage.

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

Edit `.env` with the PROD and DEV credentials and a long random `MONITOR_TOKEN`, then test:

```bash
node --env-file=.env src/index.js
```

The service listens on `127.0.0.1:8787` by default. Checks run at startup and every 15 minutes.

## Endpoints

All monitor endpoints require `Authorization: Bearer <MONITOR_TOKEN>`.

```bash
curl -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/health/all
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" http://127.0.0.1:8787/run/all
```

- `GET /health/prod`, `/health/dev`, `/health/all`: return the latest cached result immediately.
- `POST /run/prod`, `/run/dev`, `/run/all`: run a fresh check and return its result.

PROD and DEV checks are always queued instead of running Chromium sessions concurrently.

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
