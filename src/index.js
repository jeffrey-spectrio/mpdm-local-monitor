import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
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
};

const monitors = {
  prod: {
    email: process.env.MPDM_EMAIL,
    password: process.env.MPDM_PASSWORD,
    url: process.env.MPDM_URL || "https://devicemanager.spectrio.com/mpdm/",
  },
  dev: {
    email: process.env.MPDM_DEV_EMAIL,
    password: process.env.MPDM_DEV_PASSWORD,
    url: process.env.MPDM_DEV_URL || "https://mpdm-dev.inreality.com/mpdm/",
  },
};

let browser;
let checkQueue = Promise.resolve();
const latest = { prod: null, dev: null };

function elapsedSince(startedAt) {
  return Date.now() - startedAt;
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
}

async function getBrowser() {
  if (!browser?.isConnected()) {
    const startedAt = Date.now();
    browser = await chromium.launch({ headless: config.headless });
    log("browser_started", { durationMs: elapsedSince(startedAt) });
  }
  return browser;
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

    const targetUrl = new URL(monitor.url);
    const successPath = `${targetUrl.pathname.replace(/\/$/, "")}/devices`;

    const pageLoadStartedAt = Date.now();
    await page.goto(targetUrl.href, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ state: "visible", timeout: 20_000 });
    timings.loginPageLoadMs = elapsedSince(pageLoadStartedAt);

    const formFillStartedAt = Date.now();
    await emailInput.fill(monitor.email);
    await page.locator('input[type="password"]').fill(monitor.password);
    timings.formFillMs = elapsedSince(formFillStartedAt);

    const loginStartedAt = Date.now();
    await page.locator("button.login-submit").click();
    await page.waitForURL(
      (url) => url.pathname === successPath,
      { timeout: 30_000, waitUntil: "domcontentloaded" },
    );
    timings.loginSubmitMs = elapsedSince(loginStartedAt);
    timings.totalMs = elapsedSince(startedAt);

    const result = {
      ok: true,
      service: `mpdm-${name}`,
      status: "login_succeeded",
      source,
      checkedAt: new Date().toISOString(),
      durationMs: timings.totalMs,
      timings,
      finalUrl: page.url(),
    };
    latest[name] = result;
    log("login_check_completed", { target: name, ok: true, durationMs: result.durationMs });
    return result;
  } catch (error) {
    timings.totalMs = elapsedSince(startedAt);
    const result = {
      ok: false,
      service: `mpdm-${name}`,
      status: "login_failed",
      source,
      checkedAt: new Date().toISOString(),
      durationMs: timings.totalMs,
      timings,
      reason: error instanceof Error ? error.message : String(error),
      ...(page ? { finalUrl: page.url() } : {}),
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
    for (const name of targetNames) checks[name] = await checkSite(name, source);
    const ok = targetNames.every((name) => checks[name].ok);
    return {
      ok,
      service: targetNames.length === 1 ? `mpdm-${targetNames[0]}` : "mpdm-all",
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
      service: `mpdm-${targetNames[0]}`,
      status: "not_checked_yet",
    };
  }
  const checks = Object.fromEntries(targetNames.map((name) => [name, latest[name]]));
  const ready = targetNames.every((name) => checks[name]);
  const ok = ready && targetNames.every((name) => checks[name].ok);
  return {
    ok,
    service: "mpdm-all",
    status: ready ? (ok ? "all_logins_succeeded" : "one_or_more_logins_failed") : "not_checked_yet",
    checkedAt: new Date().toISOString(),
    checks,
  };
}

const targetsByPath = {
  "/health": ["prod"],
  "/health/prod": ["prod"],
  "/health/dev": ["dev"],
  "/health/all": ["prod", "dev"],
  "/run/prod": ["prod"],
  "/run/dev": ["dev"],
  "/run/all": ["prod", "dev"],
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
      endpoints: ["/health/prod", "/health/dev", "/health/all"],
      refreshEndpoints: ["POST /run/prod", "POST /run/dev", "POST /run/all"],
      authentication: "Authorization: Bearer <MONITOR_TOKEN>",
      intervalMinutes: config.intervalMs / 60_000,
    });
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

if (config.checkOnStart) runChecks(["prod", "dev"], "startup").catch((error) => log("startup_check_failed", { reason: error.message }));
setInterval(() => {
  runChecks(["prod", "dev"], "schedule").catch((error) => log("scheduled_check_failed", { reason: error.message }));
}, config.intervalMs).unref();

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
