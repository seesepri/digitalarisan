type CounterKey = { metric: string; labels: Record<string, string> };
const counters = new Map<string, { key: CounterKey; value: number }>();
const durations: number[] = [];

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function increment(metric: string, labels: Record<string, string>, amount = 1) {
  const key = `${metric}|${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("|")}`;
  const existing = counters.get(key);
  if (existing) existing.value += amount;
  else counters.set(key, { key: { metric, labels }, value: amount });
}

export function normalizeRoute(route: string): string {
  return route
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,36}\b/gi, ":id")
    .replace(/\b\d+\b/g, ":id")
    .replace(/\/+/g, "/");
}

export function recordRequest(method: string, route: string) {
  increment("digital_arisan_http_requests_total", { method, route: normalizeRoute(route) });
}

export function recordEvent(name: string, labels: Record<string, string> = {}) {
  increment("digital_arisan_events_total", { event: name, ...labels });
}

export function recordDuration(durationMs: number) {
  if (durations.length >= 1000) durations.shift();
  durations.push(durationMs);
}

export function prometheusText(operational?: { stuckTopups: number; stuckWithdrawals: number; failedFinalJobs: number; expiredJobLeases: number; failedReconciliations24h: number; recentPaymentFailures: number; recentWithdrawalFailures: number; activeUsers: number; openPeriods: number; activeParticipants: number; successfulTopups24h: number; successfulWithdrawals24h: number; completedPeriods24h: number }) {
  const lines = [
    "# HELP digital_arisan_up Application process health.",
    "# TYPE digital_arisan_up gauge",
    "digital_arisan_up 1",
    "# HELP digital_arisan_http_requests_total API requests accepted by the application process.",
    "# TYPE digital_arisan_http_requests_total counter",
    "# HELP digital_arisan_events_total Application business/operational events.",
    "# TYPE digital_arisan_events_total counter",
    "# HELP digital_arisan_process_info Process-level telemetry state.",
    "# TYPE digital_arisan_process_info gauge",
    'digital_arisan_process_info{service="digital-arisan"} 1',
  ];
  for (const { key, value } of counters.values()) {
    const labels = Object.entries(key.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",");
    lines.push(`${key.metric}{${labels}} ${value}`);
  }
  lines.push("# HELP digital_arisan_http_duration_ms_samples Number of observed request duration samples.");
  lines.push("# TYPE digital_arisan_http_duration_ms_samples gauge");
  lines.push(`digital_arisan_http_duration_ms_samples ${durations.length}`);
  if (operational) {
    lines.push("# TYPE digital_arisan_stuck_topups gauge");
    lines.push(`digital_arisan_stuck_topups ${operational.stuckTopups}`);
    lines.push("# TYPE digital_arisan_stuck_withdrawals gauge");
    lines.push(`digital_arisan_stuck_withdrawals ${operational.stuckWithdrawals}`);
    lines.push("# TYPE digital_arisan_failed_final_jobs gauge");
    lines.push(`digital_arisan_failed_final_jobs ${operational.failedFinalJobs}`);
    lines.push("# TYPE digital_arisan_expired_job_leases gauge");
    lines.push(`digital_arisan_expired_job_leases ${operational.expiredJobLeases}`);
    lines.push("# TYPE digital_arisan_reconciliation_failed_24h gauge");
    lines.push(`digital_arisan_reconciliation_failed_24h ${operational.failedReconciliations24h}`);
    lines.push("# TYPE digital_arisan_recent_payment_failures gauge");
    lines.push(`digital_arisan_recent_payment_failures ${operational.recentPaymentFailures}`);
    lines.push("# TYPE digital_arisan_recent_withdrawal_failures gauge");
    lines.push(`digital_arisan_recent_withdrawal_failures ${operational.recentWithdrawalFailures}`);
    for (const [metric, value] of Object.entries({
      digital_arisan_active_users: operational.activeUsers,
      digital_arisan_open_periods: operational.openPeriods,
      digital_arisan_active_participants: operational.activeParticipants,
      digital_arisan_successful_topups_24h: operational.successfulTopups24h,
      digital_arisan_successful_withdrawals_24h: operational.successfulWithdrawals24h,
      digital_arisan_completed_periods_24h: operational.completedPeriods24h,
    })) {
      lines.push(`# TYPE ${metric} gauge`);
      lines.push(`${metric} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
