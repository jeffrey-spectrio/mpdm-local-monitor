import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleFailureCount,
  formatCycleAlert,
  isAlertThresholdExceeded,
  targetFailureCounts,
} from "../src/alert-format.js";

const labels = {
  prod: "MPDM PROD",
  dev: "MPDM DEV",
  app: "InReality V3",
  appDev: "InReality V3 DEV",
};

function network(label, ok) {
  return {
    ok,
    proxyLabel: label,
    checks: Object.fromEntries(
      Object.keys(labels).map((name) => [name, { ok }]),
    ),
  };
}

test("counts failures per URL across direct and every proxy", () => {
  const cycle = {
    direct: network("Direct", false),
    proxyResults: [
      network("JP-Tokyo", false),
      network("UK-London", true),
      network("US-Seattle", true),
    ],
  };

  assert.deepEqual(targetFailureCounts(cycle), {
    prod: 2,
    dev: 2,
    app: 2,
    appDev: 2,
  });
  assert.equal(cycleFailureCount(cycle), 8);
  assert.equal(isAlertThresholdExceeded(cycle, 2), false);
  cycle.proxyResults[1].checks.prod.ok = false;
  cycle.proxyResults[1].ok = false;
  assert.deepEqual(targetFailureCounts(cycle), {
    prod: 3,
    dev: 2,
    app: 2,
    appDev: 2,
  });
  assert.equal(cycleFailureCount(cycle), 9);
  assert.equal(isAlertThresholdExceeded(cycle, 2), true);
});

test("does not alert when failures are spread below the per-URL threshold", () => {
  const cycle = {
    direct: {
      checks: {
        prod: { ok: false },
        dev: { ok: true },
        app: { ok: true },
        appDev: { ok: true },
      },
    },
    proxyResults: [
      { proxyLabel: "JP-Tokyo", checks: { prod: { ok: true }, dev: { ok: false }, app: { ok: true }, appDev: { ok: true } } },
      { proxyLabel: "UK-London", checks: { prod: { ok: true }, dev: { ok: true }, app: { ok: false }, appDev: { ok: true } } },
      { proxyLabel: "US-Seattle", checks: { prod: { ok: true }, dev: { ok: true }, app: { ok: true }, appDev: { ok: true } } },
    ],
  };

  assert.deepEqual(targetFailureCounts(cycle), { prod: 1, dev: 1, app: 1, appDev: 0 });
  assert.equal(isAlertThresholdExceeded(cycle, 2), false);
});

test("alert output includes every network result for triggering URL only", () => {
  const cycle = {
    checkedAt: "2026-09-04T08:00:00.000Z",
    direct: {
      ok: true,
      checks: {
        prod: { ok: true },
        dev: { ok: true },
        app: { ok: true },
        appDev: { ok: true },
      },
    },
    proxyResults: [
      {
        proxyLabel: "JP-Tokyo",
        checks: {
          prod: { ok: false, reason: "VPS timeout" },
          dev: { ok: false, reason: "VPS timeout" },
          app: { ok: true },
          appDev: { ok: true },
        },
      },
      {
        proxyLabel: "US-Seattle",
        checks: {
          prod: { ok: false, reason: "VPS timeout" },
          dev: { ok: true },
          app: { ok: true },
          appDev: { ok: true },
        },
      },
      network("SG-Singapore-Oracle", true),
    ],
  };
  const text = formatCycleAlert(cycle, { failureThreshold: 1, labels });

  assert.match(text, /\*Trigger:\* MPDM PROD \(2\/4\)/);
  assert.match(text, /MPDM PROD login check failed — 2\/4 networks failed/);
  assert.match(text, /• Direct = Pass/);
  assert.match(text, /• Proxy: 🇯🇵 JP-Tokyo = Failure/);
  assert.match(text, /↳ Reason: VPS timeout/);
  assert.match(text, /• Proxy: 🇺🇸 US-Seattle = Failure/);
  assert.match(text, /• Proxy: 🇸🇬 SG-Singapore-Oracle = Pass/);
  const parisText = formatCycleAlert(
    {
      checkedAt: "2026-09-04T08:00:00.000Z",
      direct: { checks: { prod: { ok: true } } },
      proxyResults: [
        {
          proxyLabel: "PG-Paris-AWS",
          checks: { prod: { ok: false, reason: "timeout" } },
        },
      ],
    },
    { failureThreshold: 0, labels: { prod: "MPDM PROD" } },
  );
  assert.match(parisText, /• Proxy: 🇫🇷 PG-Paris-AWS = Failure/);
  assert.doesNotMatch(text, /MPDM DEV login check/);
  assert.doesNotMatch(text, /InReality V3 login check/);
  assert.doesNotMatch(text, /InReality V3 DEV login check/);
  assert.match(text, /\*Checked:\* 2026-09-04 16:00:00 \(UTC\+8\)/);
  assert.doesNotMatch(text, /recovered/i);
  assert.match(text, /\n\n\*MPDM PROD login check failed — 2\/4 networks failed\*/);
});
