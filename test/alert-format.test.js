import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleFailureCount,
  formatCycleAlert,
  isAlertThresholdExceeded,
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

test("counts direct plus every proxy as one network failure", () => {
  const cycle = {
    direct: network("Direct", false),
    proxyResults: [
      network("JP-Tokyo", false),
      network("UK-London", false),
      network("US-Seattle", true),
      network("DE-Frankfurt", true),
    ],
  };

  assert.equal(cycleFailureCount(cycle), 3);
  assert.equal(isAlertThresholdExceeded(cycle, 3), false);
  cycle.proxyResults[3].ok = false;
  assert.equal(cycleFailureCount(cycle), 4);
  assert.equal(isAlertThresholdExceeded(cycle, 3), true);
});

test("alert output includes direct, every proxy, and every URL result", () => {
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
        ...network("JP-Tokyo", false),
        checks: Object.fromEntries(
          Object.keys(labels).map((name) => [name, { ok: false, reason: "VPS timeout" }]),
        ),
      },
      network("US-Seattle", true),
      network("SG-Singapore-Oracle", true),
    ],
  };
  const text = formatCycleAlert(cycle, { failureThreshold: 3, labels });

  assert.match(text, /MPDM PROD login check failed/);
  assert.match(text, /• Direct = Pass/);
  assert.match(text, /• Proxy: 🇯🇵 JP-Tokyo = Failure/);
  assert.match(text, /↳ Reason: VPS timeout/);
  assert.match(text, /• Proxy: 🇺🇸 US-Seattle = Pass/);
  assert.match(text, /• Proxy: 🇸🇬 SG-Singapore-Oracle = Pass/);
  assert.match(text, /MPDM DEV login check failed/);
  assert.match(text, /InReality V3 login check failed/);
  assert.match(text, /InReality V3 DEV login check failed/);
  assert.match(text, /\*Checked at:\* 2026-09-04 16:00:00 \(UTC\+8\)/);
  assert.doesNotMatch(text, /recovered/i);
  assert.match(text, /\n\n\*MPDM PROD login check failed\*/);
});
