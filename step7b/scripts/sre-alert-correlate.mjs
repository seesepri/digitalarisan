#!/usr/bin/env node
const input = process.argv[2] ? JSON.parse(process.argv[2]) : JSON.parse(await new Promise((resolve) => { let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => resolve(s)); }));
const alerts = Array.isArray(input) ? input : input.alerts || [];
const groups = new Map();
for (const alert of alerts) {
  const dependency = alert.dependency || (String(alert.name).includes("payment") ? "payment-provider" : String(alert.name).includes("withdrawal") ? "payout-provider" : String(alert.name).includes("database") || String(alert.name).includes("reconciliation") ? "postgres" : "application");
  const key = `${dependency}:${alert.name}`;
  const previous = groups.get(key);
  if (!previous || alert.severity === "critical") groups.set(key, { ...alert, dependency, fingerprint: key });
}
console.log(JSON.stringify({ timestamp: new Date().toISOString(), correlated: [...groups.values()] }, null, 2));
