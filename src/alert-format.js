export function networkResultsForCycle(cycle) {
  return [
    { label: "Direct", result: cycle.direct },
    ...(cycle.proxyResults || []).map((result) => ({
      label: `Proxy: ${result.proxyLabel || "Proxy"}`,
      result,
    })),
  ];
}

export function cycleFailureCount(cycle) {
  return Object.values(targetFailureCounts(cycle)).reduce(
    (total, count) => total + count,
    0,
  );
}

export function networkFailureCount(cycle) {
  return networkResultsForCycle(cycle).filter(({ result }) => !result?.ok).length;
}

export function targetFailureCounts(cycle) {
  const networks = networkResultsForCycle(cycle);
  const targetNames = Object.keys(cycle.direct?.checks || {});
  return Object.fromEntries(
    targetNames.map((name) => [
      name,
      networks.filter(({ result }) => !result?.checks?.[name]?.ok).length,
    ]),
  );
}

export function isAlertThresholdExceeded(cycle, failureThreshold) {
  return Object.values(targetFailureCounts(cycle)).some(
    (count) => count > failureThreshold,
  );
}

function formatCheckedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time (UTC+8)";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: partValue }) => [type, partValue]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (UTC+8)`;
}

const proxyFlags = {
  US: "🇺🇸",
  JP: "🇯🇵",
  UK: "🇬🇧",
  SG: "🇸🇬",
  ES: "🇪🇸",
  PL: "🇵🇱",
};

function formatNetworkLabel(label) {
  if (!label.startsWith("Proxy: ")) return label;
  const proxyLabel = label.slice("Proxy: ".length);
  const countryCode = proxyLabel.split("-")[0].toUpperCase();
  return `Proxy: ${proxyFlags[countryCode] || "🌐"} ${proxyLabel}`;
}

function urlResultLines(name, cycle, labels) {
  const networks = networkResultsForCycle(cycle);
  const checks = networks.map(({ label, result }) => ({
    label,
    check: result?.checks?.[name],
  }));
  const failedCount = checks.filter(({ check }) => !check?.ok).length;
  const totalCount = checks.length;
  const failed = failedCount > 0;
  const lines = [
    `*${labels[name] || name} login check ${failed ? "failed" : "passed"} — ${failedCount}/${totalCount} networks failed*`,
  ];
  for (const { label, check } of checks) {
    lines.push(`• ${formatNetworkLabel(label)} = ${check?.ok ? "Pass" : "Failure"}`);
    if (!check?.ok) {
      lines.push(`  ↳ Reason: ${check?.reason || check?.status || "Unknown error"}`);
    }
  }
  return lines;
}

export function formatCycleAlert(cycle, { failureThreshold, labels = {} }) {
  const failureCounts = targetFailureCounts(cycle);
  const networks = networkResultsForCycle(cycle);
  const triggeredTargets = Object.entries(failureCounts)
    .filter(([, count]) => count > failureThreshold)
    .map(([name, count]) => `${labels[name] || name} (${count}/${networks.length})`);
  const lines = [
    ":rotating_light: *Monitor failure alert*",
    "",
    `*Alert rule:* any URL with more than ${failureThreshold} failed networks`,
    `*Triggered by:* ${triggeredTargets.join(", ") || "none"}`,
    `*Checked at:* ${formatCheckedAt(cycle.checkedAt)}`,
  ];
  const targetNames = Object.keys(cycle.direct?.checks || {});
  for (const name of targetNames) {
    lines.push("", ...urlResultLines(name, cycle, labels));
  }
  return lines.join("\n");
}
