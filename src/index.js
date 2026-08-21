import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { chromium } from "playwright";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number.parseInt(process.env.PORT || "8787", 10),
  token: process.env.MONITOR_TOKEN || "",
  intervalMs:
    Number.parseFloat(process.env.CHECK_INTERVAL_MINUTES || "15") * 60_000,
  checkOnStart: process.env.CHECK_ON_START !== "false",
  headless: process.env.HEADLESS !== "false",
  failureNotificationThreshold: Number.parseInt(
    process.env.FAILURE_NOTIFICATION_THRESHOLD || "2",
    10,
  ),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  alertStatePath: process.env.ALERT_STATE_PATH || "data/alert-state.json",
};

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
let alertState = Object.fromEntries(
  Object.keys(monitors).map((name) => [
    name,
    { consecutiveFailures: 0, alertSent: false },
  ]),
);

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
  if (
    !Number.isInteger(config.failureNotificationThreshold) ||
    config.failureNotificationThreshold < 1
  ) {
    throw new Error("FAILURE_NOTIFICATION_THRESHOLD must be at least 1");
  }
  if (config.slackWebhookUrl && !config.slackWebhookUrl.startsWith("https://")) {
    throw new Error("SLACK_WEBHOOK_URL must use HTTPS");
  }
}

async function loadAlertState() {
  try {
    const stored = JSON.parse(await readFile(config.alertStatePath, "utf8"));
    for (const name of Object.keys(alertState)) {
      if (stored[name]) alertState[name] = stored[name];
    }
  } catch (error) {
    if (error.code !== "ENOENT") log("alert_state_load_failed", { reason: error.message });
  }
}

async function saveAlertState() {
  await mkdir(dirname(config.alertStatePath), { recursive: true });
  await writeFile(config.alertStatePath, `${JSON.stringify(alertState, null, 2)}\n`);
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

async function updateAlertState(name, result) {
  const state = alertState[name];
  if (result.ok) {
    if (state.alertSent) {
      const sent = await sendSlack(
        `:white_check_mark: ${monitors[name].label} recovered\n` +
          `Login succeeded in ${result.durationMs} ms\n${result.finalUrl}`,
      );
      if (sent) state.alertSent = false;
    }
    state.consecutiveFailures = 0;
  } else {
    state.consecutiveFailures += 1;
    if (
      state.consecutiveFailures >= config.failureNotificationThreshold &&
      !state.alertSent
    ) {
      const sent = await sendSlack(
        `:rotating_light: ${monitors[name].label} login check failed ` +
          `${state.consecutiveFailures} times consecutively\n` +
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
  const usernameInput = page.locator(
    '#username, input[name="username"], input[autocomplete="email"]',
  ).first();
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
    (url) =>
      url.origin === successUrl.origin && url.pathname === successUrl.pathname,
    { timeout: 45_000, waitUntil: "domcontentloaded" },
  );
  timings.passwordStepMs = elapsedSince(passwordStartedAt);
}

async function checkSite(name, source) {
  const startedAt = Date.now();
  const timings = {};
  const monitor = monitors[name];
  let context;
  let page;

  try {
    const activeBrowser = await getBrowser();
    const setupStartedAt = Date.now();
    context = await activeBrowser.newContext();
    page = await context.newPage();
    timings.pageSetupMs = elapsedSince(setupStartedAt);

    const pageLoadStartedAt = Date.now();
    await page.goto(monitor.url, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
    timings.loginPageLoadMs = elapsedSince(pageLoadStartedAt);

    if (monitor.flow === "two-step") {
      await completeTwoStepLogin(page, monitor, timings);
    } else {
      await completeMpdmLogin(page, monitor, timings);
    }
    timings.totalMs = elapsedSince(startedAt);

    const result = {
      ok: true,
      service: monitor.service,
      status: "login_succeeded",
      source,
      checkedAt: new Date().toISOString(),
      durationMs: timings.totalMs,
      timings,
      finalUrl: sanitizedUrl(page.url()),
    };
    latest[name] = result;
    log("login_check_completed", { target: name, ok: true, durationMs: result.durationMs });
    return result;
  } catch (error) {
    timings.totalMs = elapsedSince(startedAt);
    const result = {
      ok: false,
      service: monitor.service,
      status: "login_failed",
      source,
      checkedAt: new Date().toISOString(),
      durationMs: timings.totalMs,
      timings,
      reason: error instanceof Error ? error.message : String(error),
      ...(page && sanitizedUrl(page.url())
        ? { finalUrl: sanitizedUrl(page.url()) }
        : {}),
    };
    latest[name] = result;
    log("login_check_completed", { target: name, ok: false, reason: result.reason });
    return result;
  } finally {
    await context?.close().catch((error) => {
      log("browser_context_close_failed", { reason: error.message });
    });
  }
}

async function runChecks(targetNames, source) {
  const task = async () => {
    const startedAt = Date.now();
    const checks = {};
    for (const name of targetNames) {
      checks[name] = await checkSite(name, source);
      await updateAlertState(name, checks[name]);
    }
    const ok = targetNames.every((name) => checks[name].ok);
    return {
      ok,
      service: targetNames.length === 1 ? monitors[targetNames[0]].service : "monitor-all",
      status: ok ? "all_logins_succeeded" : "one_or_more_logins_failed",
      source,
      checkedAt: new Date().toISOString(),
      durationMs: elapsedSince(startedAt),
      checks,
    };
  };

  const result = checkQueue.then(task, task);
  checkQueue = result.then(() => undefined, () => undefined);
  return result;
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
      ],
      refreshEndpoints: [
        "POST /run/prod",
        "POST /run/dev",
        "POST /run/app",
        "POST /run/app-dev",
        "POST /run/all",
      ],
      notificationTestEndpoint: "POST /notify/test",
      authentication: "Authorization: Bearer <MONITOR_TOKEN>",
      intervalMinutes: config.intervalMs / 60_000,
      failureNotificationThreshold: config.failureNotificationThreshold,
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
const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    log("request_failed", { reason: error.message });
    if (!response.headersSent) sendJson(response, { error: "Internal server error" }, 500);
    else response.end();
  });
});

server.listen(config.port, config.host, () => {
  log("server_started", { host: config.host, port: config.port });
});

const allTargets = Object.keys(monitors);
if (config.checkOnStart) runChecks(allTargets, "startup").catch((error) => log("startup_check_failed", { reason: error.message }));
setInterval(() => {
  runChecks(allTargets, "schedule").catch((error) => log("scheduled_check_failed", { reason: error.message }));
}, config.intervalMs).unref();

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
