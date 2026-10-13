#!/usr/bin/env node
const base = (process.env.SYNTHETIC_BASE_URL || process.env.PRODUCTION_APP_URL || "http://localhost:3000").replace(/\/$/, "");
const timeoutMs = Number(process.env.SYNTHETIC_TIMEOUT_MS || 5000);
const checks = ["/api/health", "/api/ready"];
const results = [];
for (const path of checks) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "digital-arisan-synthetic/1.0" } });
    const durationMs = performance.now() - started;
    results.push({ path, status: response.status, durationMs: Math.round(durationMs), ok: response.ok });
  } catch (error) { results.push({ path, status: 0, durationMs: Math.round(performance.now() - started), ok: false, error: String(error) }); }
}
console.log(JSON.stringify({ timestamp: new Date().toISOString(), base, checks: results }, null, 2));
if (results.some((x) => !x.ok || x.durationMs > Number(process.env.SYNTHETIC_MAX_LATENCY_MS || 1000))) process.exit(1);
