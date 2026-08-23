import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { chromium } from "playwright";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function splitList(value) {
  return (value || "")
    .split(/[;,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProxyServer(value) {
  return /^[a-z]+:\/\//i.test(value) ? value : `http://${value}`;
}

function parseProxyList(value) {
  return splitList(value).map((entry, index) => {
    const equalsIndex = entry.indexOf("=");
    const label = equalsIndex > 0 ? entry.slice(0, equalsIndex).trim() : `Proxy ${index + 1}`;
    const rawServer = equalsIndex > 0 ? entry.slice(equalsIndex + 1).trim() : entry;
    const server = normalizeProxyServer(rawServer);
    const id = createHash("sha256").update(server).digest("hex").slice(0, 10);
    return { id, label, server };
  });
}

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number.parseInt(process.env.PORT || "8787", 10),
  token: process.env.MONITOR_TOKEN || "",
  intervalMs: Number.parseFloat(process.env.CHECK_INTERVAL_MINUTES || "15") * 60_000,
  checkOnStart: process.env.CHECK_ON_START !== "false",
  headless: process.env.HEADLESS !== "false",
  failureNotificationThreshold: Number.parseInt(
    process.env.FAILURE_NOTIFICATION_THRESHOLD || "2",
    10,
  ),
  proxyFailureNotificationThreshold: Number.parseInt(
    process.env.PROXY_FAILURE_NOTIFICATION_THRESHOLD || "1",
    10,
  ),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  alertStatePath: process.env.ALERT_STATE_PATH || "data/alert-state.json",
  proxyCheckIntervalMs:
    Number.parseFloat(process.env.PROXY_CHECK_INTERVAL_MINUTES || "120") * 60_000,
  proxyCheckOnStart: process.env.PROXY_CHECK_ON_START === "true",
  proxyUsername: process.env.PROXY_USERNAME || "",
  proxyPassword: process.env.PROXY_PASSWORD || "",
  proxyStatePath: process.env.PROXY_STATE_PATH || "data/proxy-state.json",
  proxyIpCheckUrl: process.env.PROXY_IP_CHECK_URL || "https://ipv4.webshare.io/",
  proxyTargetNames: splitList(process.env.PROXY_TARGETS || "prod,app"),
  proxyBlockNonessential: process.env.PROXY_BLOCK_NONESSENTIAL !== "false",
};

const proxies = parseProxyList(process.env.PROXY_LIST || "");
const PROXY_BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);
const PROXY_BLOCKED_HOSTNAMES = new Set([
  "www.googletagmanager.com",
  "www.google-analytics.com",
  "region1.google-analytics.com",
  "fonts.googleapis.com",
  "rsms.me",
]);

const monitors = {
  prod: {
    service: "mpdm-prod",
    label: "MPDM PROD",
    flow: "mpdm",
    email: process.env.MPDM_EMAIL,
    password: process.env.MPDM_PASSWORD,
    url: process.env.MPDM_URL || "https://devicemanager.spectrio.com/mpdm/",
  },
  dev: {
    service: "mpdm-dev",
    label: "MPDM DEV",
    flow: "mpdm",
    email: process.env.MPDM_DEV_EMAIL,
    password: process.env.MPDM_DEV_PASSWORD,
    url: process.env.MPDM_DEV_URL || "https://mpdm-dev.inreality.com/mpdm/",
  },
  app: {
    service: "inreality-v3",
    label: "InReality V3",
    flow: "two-step",
    email: process.env.INREALITY_EMAIL,
    password: process.env.INREALITY_PASSWORD,
    url: process.env.INREALITY_URL || "https://app.inreality.com/v3/",
    successUrl:
      process.env.INREALITY_SUCCESS_URL || "https://app.inreality.com/v3/auth0/",
  },
  appDev: {
    service: "inreality-v3-dev",
    label: "InReality V3 DEV",
    flow: "two-step",
    email: process.env.INREALITY_DEV_EMAIL,
    password: process.env.INREALITY_DEV_PASSWORD,
    url: process.env.INREALITY_DEV_URL || "https://v3-dev.inreality.com/v3/",
    successUrl:
      process.env.INREALITY_DEV_SUCCESS_URL ||
      "https://v3-dev.inreality.com/v3/auth0/",
  },
};

let browser;
let checkQueue = Promise.resolve();
const latest = Object.fromEntries(Object.keys(monitors).map((name) => [name, null]));
let latestProxyCycle = null;
let alertState = Object.fromEntries(
  Object.keys(monitors).map((name) => [name, { consecutiveFailures: 0, alertSent: false }]),
);
let proxyState = { nextIndex: 0 };

function elapsedSince(startedAt) {
  return Date.now() - startedAt;
}

function sanitizedUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function log(event, details = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(data, null, 2));
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function validateConfig() {
  const missing = [];
  for (const [name, monitor] of Object.entries(monitors)) {
    if (!monitor.email) missing.push(`${name} email`);
    if (!monitor.password) missing.push(`${name} password`);
  }
  if (!config.token) missing.push("MONITOR_TOKEN");
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("PORT must be between 1 and 65535");
  }
  if (!Number.isFinite(config.intervalMs) || config.intervalMs < 60_000) {
    throw new Error("CHECK_INTERVAL_MINUTES must be at least 1");
  }
  if (!Number.isFinite(config.proxyCheckIntervalMs) || config.proxyCheckIntervalMs < 60_000) {
    throw new Error("PROXY_CHECK_INTERVAL_MINUTES must be at least 1");
  }
  if (!Number.isInteger(config.failureNotificationThreshold) || config.failureNotificationThreshold < 1) {
    throw new Error("FAILURE_NOTIFICATION_THRESHOLD must be at least 1");
  }
  if (!Number.isInteger(config.proxyFailureNotificationThreshold) || config.proxyFailureNotificationThreshold < 1) {
    throw new Error("PROXY_FAILURE_NOTIFICATION_THRESHOLD must be at least 1");
  }
  if (config.slackWebhookUrl && !config.slackWebhookUrl.startsWith("https://")) {
    throw new Error("SLACK_WEBHOOK_URL must use HTTPS");
  }
  for (const name of config.proxyTargetNames) {
    if (!monitors[name]) throw new Error(`Unknown PROXY_TARGETS entry: ${name}`);
  }
}

async function loadAlertState() {
  try {
    const stored = JSON.parse(await readFile(config.alertStatePath, "utf8"));
    alertState = { ...alertState, ...stored };
  } catch (error) {
    if (error.code !== "ENOENT") log("alert_state_load_failed", { reason: error.message });
  }
}

async function saveAlertState() {
  await mkdir(dirname(config.alertStatePath), { recursive: true });
  await writeFile(config.alertStatePath, `${JSON.stringify(alertState, null, 2)}\n`);
}

async function loadProxyState() {
  try {
    const stored = JSON.parse(await readFile(config.proxyStatePath, "utf8"));
    if (Number.isInteger(stored.nextIndex) && stored.nextIndex >= 0) proxyState = stored;
  } catch (error) {
    if (error.code !== "ENOENT") log("proxy_state_load_failed", { reason: error.message });
  }
}

async function saveProxyState() {
  await mkdir(dirname(config.proxyStatePath), { recursive: true });
  await writeFile(config.proxyStatePath, `${JSON.stringify(proxyState, null, 2)}\n`);
}

async function sendSlack(text) {
  if (!config.slackWebhookUrl) {
    log("slack_notification_skipped", { reason: "SLACK_WEBHOOK_URL is not configured" });
    return false;
  }
  try {
    const response = await fetch(config.slackWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
    log("slack_notification_sent");
    return true;
  } catch (error) {
    log("slack_notification_failed", { reason: error.message });
    return false;
  }
}

function alertStateFor(key) {
  if (!alertState[key]) alertState[key] = { consecutiveFailures: 0, alertSent: false };
  return alertState[key];
}

function networkDescription(result) {
  if (result.network !== "proxy") return "Direct";
  return `${result.proxyLabel || "Proxy"}${result.exitIp ? ` (${result.exitIp})` : ""}`;
}

async function updateAlertState(
  name,
  result,
  key = name,
  threshold = config.failureNotificationThreshold,
  { repeatFailureAlerts = false } = {},
) {
  const state = alertStateFor(key);
  const network = networkDescription(result);
  if (result.ok) {
    if (state.alertSent) {
      const sent = await sendSlack(
        `:white_check_mark: ${monitors[name].label} recovered\n` +
          `Network: ${network}\n` +
          `Login succeeded in ${result.durationMs} ms\n${result.finalUrl || ""}`,
      );
      if (sent) state.alertSent = false;
    }
    state.consecutiveFailures = 0;
  } else {
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= threshold && (!state.alertSent || repeatFailureAlerts)) {
      const sent = await sendSlack(
        `:rotating_light: ${monitors[name].label} login check failed ` +
          `${state.consecutiveFailures} time${state.consecutiveFailures === 1 ? "" : "s"} consecutively\n` +
          `Network: ${network}\n` +
          `Reason: ${result.reason || result.status}\n` +
          `Checked: ${result.checkedAt}`,
      );
      if (sent) state.alertSent = true;
    }
  }
  await saveAlertState().catch((error) => {
    log("alert_state_save_failed", { reason: error.message });
  });
}

async function getBrowser() {
  if (!browser?.isConnected()) {
    const startedAt = Date.now();
    browser = await chromium.launch({ headless: config.headless });
    log("browser_started", { durationMs: elapsedSince(startedAt) });
  }
  return browser;
}

function contextOptionsFor(proxy) {
  if (!proxy) return {};
  return {
    proxy: {
      server: proxy.server,
      ...(config.proxyUsername ? { username: config.proxyUsername } : {}),
      ...(config.proxyPassword ? { password: config.proxyPassword } : {}),
    },
  };
}

function shouldBlockProxyRequest(request, stats) {
  if (!config.proxyBlockNonessential) return false;
  if (stats.stopAfterLogin) return true;
  if (PROXY_BLOCKED_RESOURCE_TYPES.has(request.resourceType())) return true;
  try {
    return PROXY_BLOCKED_HOSTNAMES.has(new URL(request.url()).hostname);
  } catch {
    return false;
  }
}

async function enableProxyRequestFiltering(context, stats) {
  if (!config.proxyBlockNonessential) return;
  await context.route("**/*", async (route) => {
    if (shouldBlockProxyRequest(route.request(), stats)) {
      stats.blockedRequests += 1;
      if (stats.stopAfterLogin) stats.postLoginBlockedRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function resolveProxyExitIp(proxy) {
  let context;
  try {
    const activeBrowser = await getBrowser();
    context = await activeBrowser.newContext(contextOptionsFor(proxy));
    const page = await context.newPage();
    await page.goto(config.proxyIpCheckUrl, { timeout: 20_000, waitUntil: "domcontentloaded" });
    return (await page.locator("body").innerText()).trim().split(/\s+/)[0] || undefined;
  } catch (error) {
    log("proxy_ip_check_failed", { proxy: proxy.label, reason: error.message });
    return undefined;
  } finally {
    await context?.close().catch(() => {});
  }
}

async function completeMpdmLogin(page, monitor, timings) {
  const targetUrl = new URL(monitor.url);
  const successPath = `${targetUrl.pathname.replace(/\/$/, "")}/devices`;
  const emailInput = page.locator('input[type="email"]');
  await emailInput.waitFor({ state: "visible", timeout: 20_000 });
  const formFillStartedAt = Date.now();
  await emailInput.fill(monitor.email);
  await page.locator('input[type="password"]').fill(monitor.password);
  timings.formFillMs = elapsedSince(formFillStartedAt);
  const loginStartedAt = Date.now();
  await page.locator("button.login-submit").click();
  await page.waitForURL((url) => url.pathname === successPath, {
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  timings.loginSubmitMs = elapsedSince(loginStartedAt);
}

async function completeTwoStepLogin(page, monitor, timings) {
  const usernameStartedAt = Date.now();
  const usernameInput = page
    .locator('#username, input[name="username"], input[autocomplete="email"]')
    .first();
  await usernameInput.waitFor({ state: "visible", timeout: 20_000 });
  await usernameInput.fill(monitor.email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  timings.usernameStepMs = elapsedSince(usernameStartedAt);
  const passwordStartedAt = Date.now();
  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.waitFor({ state: "visible", timeout: 20_000 });
  await passwordInput.fill(monitor.password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const successUrl = new URL(monitor.successUrl);
  await page.waitForURL(
    (url) => url.origin === successUrl.origin && url.pathname === successUrl.pathname,
    { timeout: 45_000, waitUntil: "domcontentloaded" },
  );
  timings.passwordStepMs = elapsedSince(passwordStartedAt);
}

async function checkSite(name, source, network = {}) {
  const startedAt = Date.now();
  const timings = {};
  const stats = { blockedRequests: 0, postLoginBlockedRequests: 0, stopAfterLogin: false };
  const monitor = monitors[name];
  let context;
  let page;
  try {
    const activeBrowser = await getBrowser();
    const setupStartedAt = Date.now();
    context = await activeBrowser.newContext(contextOptionsFor(network.proxy));
    if (network.proxy) await enableProxyRequestFiltering(context, stats);
    page = await context.newPage();
    timings.pageSetupMs = elapsedSince(setupStartedAt);
    const pageLoadStartedAt = Date.now();
    await page.goto(monitor.url, { timeout: 30_000, waitUntil: "domcontentloaded" });
    timings.loginPageLoadMs = elapsedSince(pageLoadStartedAt);
    if (monitor.flow === "two-step") {
      await completeTwoStepLogin(page, monitor, timings);
    } else {
      await completeMpdmLogin(page, monitor, timings);
    }
    if (network.proxy && config.proxyBlockNonessential) {
      stats.stopAfterLogin = true;
      await page.evaluate(() => window.stop()).catch(() => {});
    }
    timings.totalMs = elapsedSince(startedAt);
    const result = {
      ok: true,
      service: monitor.service,
      status: "login_succeeded",
      source,
      network: network.proxy ? "proxy" : "direct",
      ...(network.proxy
        ? {
            proxyId: network.proxy.id,
            proxyLabel: network.proxy.label,
            proxyServer: network.proxy.server,
            blockedRequests: stats.blockedRequests,
            postLoginBlockedRequests: stats.postLoginBlockedRequests,
            ...(network.exitIp ? { exitIp: network.exitIp } : {}),
          }
        : {}),
      checkedAt: new Date().toISOString(),
      durationMs: timings.totalMs,
      timings,
      finalUrl: sanitizedUrl(page.url()),
    };
    if (!network.proxy) latest[name] = result;
    log("login_check_completed", {
      target: name,
      network: result.network,
      proxy: network.proxy?.label,
      ok: true,
      durationMs: result.durationMs,
      ...(network.proxy
        ? {
            blockedRequests: stats.blockedRequests,
            postLoginBlockedRequests: stats.postLoginBlockedRequests,
          }
        : {}),
    });
    return result;
  } catch (error) {
    timings.totalMs = elapsedSince(startedAt);
    const result = {
      ok: false,
      service: monitor.service,
      status: "login_failed",
      source,
      network: network.proxy ? "proxy" : "direct",
      ...(network.proxy
        ? {
            proxyId: network.proxy.id,
            proxyLabel: network.proxy.label,
            proxyServer: network.proxy.server,
            blockedRequests: stats.blockedRequests,
            postLoginBlockedRequests: stats.postLoginBlockedRequests,
            ...(network.exitIp ? { exitIp: network.exitIp } : {}),
          }
        : {}),
      checkedAt: new Date().toISOString(),
      durationMs: timings.totalMs,
      timings,
      reason: error instanceof Error ? error.message : String(error),
      ...(page && sanitizedUrl(page.url()) ? { finalUrl: sanitizedUrl(page.url()) } : {}),
    };
    if (!network.proxy) latest[name] = result;
    log("login_check_completed", {
      target: name,
      network: result.network,
      proxy: network.proxy?.label,
      ok: false,
      reason: result.reason,
      ...(network.proxy
        ? {
            blockedRequests: stats.blockedRequests,
            postLoginBlockedRequests: stats.postLoginBlockedRequests,
          }
        : {}),
    });
    return result;
  } finally {
    await context?.close().catch((error) => {
      log("browser_context_close_failed", { reason: error.message });
    });
  }
}

async function executeChecks(targetNames, source, network = {}) {
  const startedAt = Date.now();
  const checks = {};
  for (const name of targetNames) {
    checks[name] = await checkSite(name, source, network);
    const isProxy = Boolean(network.proxy);
    const alertKey = isProxy ? `${name}:proxy` : name;
    const threshold = isProxy
      ? config.proxyFailureNotificationThreshold
      : config.failureNotificationThreshold;
    await updateAlertState(name, checks[name], alertKey, threshold, {
      repeatFailureAlerts: isProxy,
    });
  }
  const ok = targetNames.every((name) => checks[name].ok);
  return {
    ok,
    service: targetNames.length === 1 ? monitors[targetNames[0]].service : "monitor-all",
    status: ok ? "all_logins_succeeded" : "one_or_more_logins_failed",
    source,
    network: network.proxy ? "proxy" : "direct",
    ...(network.proxy
      ? {
          proxyId: network.proxy.id,
          proxyLabel: network.proxy.label,
          proxyServer: network.proxy.server,
          blockedRequests: Object.values(checks).reduce(
            (total, result) => total + (result.blockedRequests || 0),
            0,
          ),
          postLoginBlockedRequests: Object.values(checks).reduce(
            (total, result) => total + (result.postLoginBlockedRequests || 0),
            0,
          ),
          ...(network.exitIp ? { exitIp: network.exitIp } : {}),
        }
      : {}),
    checkedAt: new Date().toISOString(),
    durationMs: elapsedSince(startedAt),
    checks,
  };
}

function enqueue(task) {
  const result = checkQueue.then(task, task);
  checkQueue = result.then(() => undefined, () => undefined);
  return result;
}

function runChecks(targetNames, source) {
  return enqueue(() => executeChecks(targetNames, source));
}

async function runNextProxyChecks(source) {
  if (!proxies.length) {
    return {
      ok: false,
      service: "proxy-monitor",
      status: "proxy_not_configured",
      source,
      checkedAt: new Date().toISOString(),
    };
  }
  const index = proxyState.nextIndex % proxies.length;
  const proxy = proxies[index];
  proxyState.nextIndex = (index + 1) % proxies.length;
  await saveProxyState().catch((error) => {
    log("proxy_state_save_failed", { reason: error.message });
  });
  return enqueue(async () => {
    const exitIp = await resolveProxyExitIp(proxy);
    const result = await executeChecks(config.proxyTargetNames, source, { proxy, exitIp });
    latestProxyCycle = {
      ...result,
      proxyIndex: index + 1,
      proxyCount: proxies.length,
      nextProxyLabel: proxies[proxyState.nextIndex % proxies.length]?.label,
    };
    return latestProxyCycle;
  });
}

function healthResult(targetNames) {
  if (targetNames.length === 1) {
    return latest[targetNames[0]] || {
      ok: false,
      service: monitors[targetNames[0]].service,
      status: "not_checked_yet",
    };
  }
  const checks = Object.fromEntries(targetNames.map((name) => [name, latest[name]]));
  const ready = targetNames.every((name) => checks[name]);
  const ok = ready && targetNames.every((name) => checks[name].ok);
  return {
    ok,
    service: "monitor-all",
    status: ready ? (ok ? "all_logins_succeeded" : "one_or_more_logins_failed") : "not_checked_yet",
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function proxyHealthResult() {
  if (latestProxyCycle) return latestProxyCycle;
  return {
    ok: false,
    service: "proxy-monitor",
    status: proxies.length ? "not_checked_yet" : "proxy_not_configured",
    configuredProxies: proxies.length,
    proxyTargets: config.proxyTargetNames,
    proxyBlockNonessential: config.proxyBlockNonessential,
    nextProxyLabel: proxies[proxyState.nextIndex % Math.max(proxies.length, 1)]?.label,
  };
}

const targetsByPath = {
  "/health": ["prod"],
  "/health/prod": ["prod"],
  "/health/dev": ["dev"],
  "/health/app": ["app"],
  "/health/app-dev": ["appDev"],
  "/health/all": ["prod", "dev", "app", "appDev"],
  "/run/prod": ["prod"],
  "/run/dev": ["dev"],
  "/run/app": ["app"],
  "/run/app-dev": ["appDev"],
  "/run/all": ["prod", "dev", "app", "appDev"],
};

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("allow", "GET, POST");
    return sendJson(response, { error: "Method not allowed" }, 405);
  }
  if (requestUrl.pathname === "/") {
    return sendJson(response, {
      service: "mpdm-local-monitor",
      endpoints: [
        "/health/prod",
        "/health/dev",
        "/health/app",
        "/health/app-dev",
        "/health/all",
        "/health/proxy",
      ],
      refreshEndpoints: [
        "POST /run/prod",
        "POST /run/dev",
        "POST /run/app",
        "POST /run/app-dev",
        "POST /run/all",
        "POST /run/proxy",
      ],
      notificationTestEndpoint: "POST /notify/test",
      authentication: "Authorization: Bearer <MONITOR_TOKEN>",
      intervalMinutes: config.intervalMs / 60_000,
      proxyIntervalMinutes: config.proxyCheckIntervalMs / 60_000,
      configuredProxies: proxies.length,
      proxyTargets: config.proxyTargetNames,
      proxyBlockNonessential: config.proxyBlockNonessential,
      failureNotificationThreshold: config.failureNotificationThreshold,
      proxyFailureNotificationThreshold: config.proxyFailureNotificationThreshold,
    });
  }
  if (requestUrl.pathname === "/notify/test") {
    if (request.method !== "POST") return sendJson(response, { error: "Use POST" }, 405);
    if (!tokenMatches(bearerToken(request), config.token)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    const sent = await sendSlack(":test_tube: MPDM Local Monitor Slack notification test succeeded.");
    return sendJson(
      response,
      { ok: sent, status: sent ? "notification_sent" : "notification_failed" },
      sent ? 200 : 502,
    );
  }
  if (requestUrl.pathname === "/health/proxy") {
    if (!tokenMatches(bearerToken(request), config.token)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    const result = proxyHealthResult();
    return sendJson(response, result, result.ok ? 200 : 503);
  }
  if (requestUrl.pathname === "/run/proxy") {
    if (request.method !== "POST") return sendJson(response, { error: "Use POST" }, 405);
    if (!tokenMatches(bearerToken(request), config.token)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    const result = await runNextProxyChecks("http");
    return sendJson(response, result, result.ok ? 200 : 502);
  }
  const targetNames = targetsByPath[requestUrl.pathname];
  if (!targetNames) return sendJson(response, { error: "Not found" }, 404);
  if (!tokenMatches(bearerToken(request), config.token)) {
    return sendJson(response, { error: "Unauthorized" }, 401);
  }
  if (requestUrl.pathname.startsWith("/run/")) {
    if (request.method !== "POST") return sendJson(response, { error: "Use POST" }, 405);
    const result = await runChecks(targetNames, "http");
    return sendJson(response, result, result.ok ? 200 : 502);
  }
  const result = healthResult(targetNames);
  return sendJson(response, result, result.ok ? 200 : 503);
}

async function shutdown(signal) {
  log("shutdown", { signal });
  await browser?.close().catch(() => {});
  process.exit(0);
}

validateConfig();
await loadAlertState();
await loadProxyState();

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    log("request_failed", { reason: error.message });
    if (!response.headersSent) sendJson(response, { error: "Internal server error" }, 500);
    else response.end();
  });
});

server.listen(config.port, config.host, () => {
  log("server_started", {
    host: config.host,
    port: config.port,
    configuredProxies: proxies.length,
    proxyIntervalMinutes: config.proxyCheckIntervalMs / 60_000,
    proxyBlockNonessential: config.proxyBlockNonessential,
  });
});

const allTargets = Object.keys(monitors);
if (config.checkOnStart) {
  runChecks(allTargets, "startup").catch((error) =>
    log("startup_check_failed", { reason: error.message }),
  );
}
setInterval(() => {
  runChecks(allTargets, "schedule").catch((error) =>
    log("scheduled_check_failed", { reason: error.message }),
  );
}, config.intervalMs).unref();

if (proxies.length) {
  if (config.proxyCheckOnStart) {
    runNextProxyChecks("proxy-startup").catch((error) =>
      log("proxy_startup_check_failed", { reason: error.message }),
    );
  }
  setInterval(() => {
    runNextProxyChecks("proxy-schedule").catch((error) =>
      log("proxy_scheduled_check_failed", { reason: error.message }),
    );
  }, config.proxyCheckIntervalMs).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
