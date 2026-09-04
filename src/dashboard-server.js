import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const dashboardStartedAt = Date.now();

function configuredProxyCount() {
  const proxyList =
    process.env.PROXY_LIST ||
    (process.env.PROXY_URL ? `VPS=${process.env.PROXY_URL}` : "");
  return proxyList.split(/[;,\n]+/).filter((item) => item.trim()).length;
}

const config = {
  host: process.env.DASHBOARD_HOST || "0.0.0.0",
  port: Number.parseInt(process.env.DASHBOARD_PORT || "8781", 10),
  monitorUrl: process.env.DASHBOARD_MONITOR_URL || "http://127.0.0.1:8780",
  monitorToken: process.env.MONITOR_TOKEN || "",
  monitorLogPath: process.env.DASHBOARD_MONITOR_LOG_PATH || "monitor.log",
  historyPath: process.env.DASHBOARD_HISTORY_PATH || "data/dashboard-history.json",
  historyLimit: Number.parseInt(process.env.DASHBOARD_HISTORY_LIMIT || "500", 10),
  pollIntervalMs: Number.parseFloat(process.env.DASHBOARD_POLL_INTERVAL_SECONDS || "30") * 1000,
  directIntervalMinutes: Number.parseFloat(process.env.CHECK_INTERVAL_MINUTES || "15"),
  proxyIntervalMinutes: Number.parseFloat(process.env.CHECK_INTERVAL_MINUTES || "15"),
};

const dashboardPath = resolve(projectRoot, "public/dashboard.html");
const monitorLogPath = isAbsolute(config.monitorLogPath)
  ? config.monitorLogPath
  : resolve(projectRoot, config.monitorLogPath);
let dashboardHtml = "";
let history = [];
let latestDirect = null;
let latestProxy = null;
let monitorSchedulerAnchorAt = null;
let lastSnapshotKeys = new Set();

function log(event, details = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(data, null, 2));
}

function sendHtml(response) {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(dashboardHtml);
}

async function monitorJson(path) {
  const response = await fetch(`${config.monitorUrl}${path}`, {
    headers: { authorization: `Bearer ${config.monitorToken}` },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 503) {
    throw new Error(`Monitor ${path} returned HTTP ${response.status}`);
  }
  return body;
}

function historyItem(name, result) {
  if (!result?.checkedAt) return null;
  return {
    checkedAt: result.checkedAt,
    ok: Boolean(result.ok),
    service: result.service,
    label: name,
    network: result.network || "direct",
    durationMs: result.durationMs,
    proxyLabel: result.proxyLabel,
    exitIp: result.exitIp,
    reason: result.ok ? undefined : result.reason || result.status,
  };
}

function addHistory(item) {
  if (!item) return false;
  const key = `${item.checkedAt}|${item.network}|${item.service}|${item.proxyLabel || ""}`;
  if (lastSnapshotKeys.has(key)) return false;
  lastSnapshotKeys.add(key);
  history.unshift(item);
  if (history.length > config.historyLimit) history.length = config.historyLimit;
  return true;
}

async function saveHistory() {
  await mkdir(dirname(config.historyPath), { recursive: true });
  await writeFile(config.historyPath, `${JSON.stringify(history, null, 2)}\n`);
}

async function loadHistory() {
  try {
    const stored = JSON.parse(await readFile(config.historyPath, "utf8"));
    if (Array.isArray(stored)) history = stored.slice(0, config.historyLimit);
    lastSnapshotKeys = new Set(
      history.map((item) => `${item.checkedAt}|${item.network}|${item.service}|${item.proxyLabel || ""}`),
    );
  } catch (error) {
    if (error.code !== "ENOENT") log("dashboard_history_load_failed", { reason: error.message });
  }
}

async function refreshSchedulerAnchor() {
  try {
    const text = await readFile(monitorLogPath, "utf8");
    const lines = text.trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes('"event":"server_started"')) continue;
      try {
        const entry = JSON.parse(lines[index]);
        const timestamp = new Date(entry.at).getTime();
        if (Number.isFinite(timestamp)) {
          monitorSchedulerAnchorAt = timestamp;
          return;
        }
      } catch {
        // Keep scanning older server_started entries if a line is malformed.
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      log("dashboard_monitor_log_read_failed", { reason: error.message });
    }
  }
}

async function refreshSnapshots() {
  try {
    const [direct, proxy] = await Promise.all([
      monitorJson("/health/all"),
      monitorJson("/health/proxy"),
      refreshSchedulerAnchor(),
    ]);
    latestDirect = direct;
    latestProxy = proxy;

    let changed = false;
    for (const [name, result] of Object.entries(direct.checks || {})) {
      changed = addHistory(historyItem(name, result)) || changed;
    }
    const proxyResults = Array.isArray(proxy.proxyResults)
      ? proxy.proxyResults
      : [proxy];
    for (const proxyResult of proxyResults) {
      for (const [name, result] of Object.entries(proxyResult.checks || {})) {
        changed = addHistory(historyItem(name, result)) || changed;
      }
    }
    if (changed) await saveHistory();
  } catch (error) {
    log("dashboard_refresh_failed", { reason: error.message });
  }
}

function newestCheckedAt(checks = {}) {
  const timestamps = Object.values(checks)
    .map((item) => item?.checkedAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function nextScheduledRunAt(intervalMinutes) {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return null;
  const anchor = monitorSchedulerAnchorAt || dashboardStartedAt;
  const intervalMs = intervalMinutes * 60_000;
  const elapsed = Math.max(0, Date.now() - anchor);
  const periods = Math.floor(elapsed / intervalMs) + 1;
  return new Date(anchor + periods * intervalMs).toISOString();
}

function validateConfig() {
  if (!config.monitorToken) throw new Error("MONITOR_TOKEN is required");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("DASHBOARD_PORT must be between 1 and 65535");
  }
  if (!Number.isInteger(config.historyLimit) || config.historyLimit < 10) {
    throw new Error("DASHBOARD_HISTORY_LIMIT must be at least 10");
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 5000) {
    throw new Error("DASHBOARD_POLL_INTERVAL_SECONDS must be at least 5");
  }
}

validateConfig();
dashboardHtml = await readFile(dashboardPath, "utf8");
await loadHistory();
await refreshSchedulerAnchor();
await refreshSnapshots();

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    return sendJson(response, { error: "Method not allowed" }, 405);
  }

  if (url.pathname === "/" || url.pathname === "/dashboard") return sendHtml(response);
  if (url.pathname === "/health/all") {
    return sendJson(response, latestDirect || { ok: false, status: "not_checked_yet", checks: {} }, latestDirect?.ok ? 200 : 503);
  }
  if (url.pathname === "/health/proxy") {
    return sendJson(response, latestProxy || { ok: false, status: "not_checked_yet", checks: {} }, latestProxy?.ok ? 200 : 503);
  }
  if (url.pathname === "/api/history") return sendJson(response, { history });
  if (url.pathname === "/api/meta") {
    const directLastCheckedAt = newestCheckedAt(latestDirect?.checks || {});
    const proxyLastCheckedAt = newestCheckedAt(latestProxy?.checks || {});
    return sendJson(response, {
      service: "mpdm-monitor-dashboard",
      readOnly: true,
      intervalMinutes: config.directIntervalMinutes,
      proxyIntervalMinutes: config.proxyIntervalMinutes,
      configuredProxies: configuredProxyCount(),
      historyLimit: config.historyLimit,
      directLastCheckedAt: directLastCheckedAt ? new Date(directLastCheckedAt).toISOString() : null,
      proxyLastCheckedAt: proxyLastCheckedAt ? new Date(proxyLastCheckedAt).toISOString() : null,
      schedulerAnchorAt: monitorSchedulerAnchorAt ? new Date(monitorSchedulerAnchorAt).toISOString() : null,
      nextDirectRunAt: nextScheduledRunAt(config.directIntervalMinutes),
      nextProxyRunAt: nextScheduledRunAt(config.proxyIntervalMinutes),
    });
  }
  return sendJson(response, { error: "Not found" }, 404);
});

server.listen(config.port, config.host, () => {
  log("dashboard_server_started", {
    host: config.host,
    port: config.port,
    monitorUrl: config.monitorUrl,
    historyLimit: config.historyLimit,
  });
});

setInterval(refreshSnapshots, config.pollIntervalMs).unref();

async function shutdown(signal) {
  log("dashboard_shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
