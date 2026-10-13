import { getOperationalSnapshot } from "@/server/services/observability";

export type SloDefinition = {
  name: string;
  target: number;
  window: string;
  sli: string;
};

export const SLO_DEFINITIONS: SloDefinition[] = [
  { name: "api_availability", target: 0.995, window: "30d", sli: "successful API requests / eligible API requests" },
  { name: "api_latency", target: 0.99, window: "30d", sli: "API requests <= 750ms / eligible API requests" },
  { name: "financial_integrity", target: 0.9999, window: "30d", sli: "financial transactions without reconciliation issue / financial transactions" },
  { name: "payment_provider_success", target: 0.995, window: "30d", sli: "successful provider operations / provider operations" },
];

export type Alert = { name: string; severity: "warning" | "critical"; message: string; fingerprint?: string; dependency?: string };

export function correlateAlerts(alerts: Alert[]): Alert[] {
  const groups = new Map<string, Alert>();
  for (const alert of alerts) {
    const dependency = alert.dependency ?? (alert.name.includes("payment") ? "payment-provider" : alert.name.includes("withdrawal") ? "payout-provider" : alert.name.includes("database") || alert.name.includes("reconciliation") ? "postgres" : "application");
    const fingerprint = alert.fingerprint ?? `${dependency}:${alert.name}`;
    const existing = groups.get(fingerprint);
    if (!existing || (alert.severity === "critical" && existing.severity !== "critical")) groups.set(fingerprint, { ...alert, fingerprint, dependency });
  }
  return [...groups.values()];
}

export async function getBusinessMetrics() {
  const snapshot = await getOperationalSnapshot();
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    financialSourceOfTruth: "postgres-primary",
    cacheExcludedFromFinancialTruth: true,
  };
}

export function errorBudgetRemaining(target: number, observedGoodRatio: number): number {
  if (!Number.isFinite(target) || !Number.isFinite(observedGoodRatio)) return 0;
  if (target >= 1) return observedGoodRatio >= target ? 1 : 0;
  return Math.max(0, Math.min(1, (observedGoodRatio - target) / (1 - target)));
}
