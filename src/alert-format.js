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

function resultLines(label, result, labels) {
  const lines = [`${label} = ${result?.ok ? "Pass" : "Failure"}`];
  for (const [name, check] of Object.entries(result?.checks || {})) {
    const detail = check.ok ? "" : ` — ${check.reason || check.status}`;
    lines.push(`  ${labels[name] || name}: ${check.ok ? "Pass" : "Failure"}${detail}`);
  }
  return lines;
}

export function formatCycleAlert(
  cycle,
  { failureThreshold, labels = {}, recovered = false },
) {
  const failureCount = cycleFailureCount(cycle);
  const title = recovered
    ? ":white_check_mark: Monitor alert recovered"
    : ":rotating_light: Monitor failure threshold exceeded";
  const lines = [
    title,
    `Network failures: ${failureCount}`,
    `Alert when failures > ${failureThreshold}`,
  ];
  for (const { label, result } of networkResultsForCycle(cycle)) {
    lines.push(...resultLines(label, result, labels));
  }
  return lines.join("\n");
}
