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
  return networkResultsForCycle(cycle).filter(({ result }) => !result?.ok).length;
}

export function isAlertThresholdExceeded(cycle, failureThreshold) {
  return cycleFailureCount(cycle) > failureThreshold;
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

function urlResultLines(name, cycle, labels) {
  const networks = networkResultsForCycle(cycle);
  const checks = networks.map(({ label, result }) => ({
    label,
    check: result?.checks?.[name],
  }));
  const failed = checks.some(({ check }) => !check?.ok);
  const lines = [`*${labels[name] || name} login check ${failed ? "failed" : "passed"}*`];
  for (const { label, check } of checks) {
    lines.push(`• ${label} = ${check?.ok ? "Pass" : "Failure"}`);
    if (!check?.ok) {
      lines.push(`  ↳ Reason: ${check?.reason || check?.status || "Unknown error"}`);
    }
  }
  return lines;
}

export function formatCycleAlert(cycle, { failureThreshold, labels = {} }) {
  const failureCount = cycleFailureCount(cycle);
  const lines = [
    ":rotating_light: *Monitor failure alert*",
    "",
    `*Network failures:* ${failureCount}`,
    `*Alert when failures >:* ${failureThreshold}`,
    `*Checked at:* ${formatCheckedAt(cycle.checkedAt)}`,
  ];
  const targetNames = Object.keys(cycle.direct?.checks || {});
  for (const name of targetNames) {
    lines.push("", ...urlResultLines(name, cycle, labels));
  }
  return lines.join("\n");
}
