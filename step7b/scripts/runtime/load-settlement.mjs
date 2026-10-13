const url = process.env.SETTLEMENT_LOAD_URL;
if (!url) throw new Error("SETTLEMENT_LOAD_URL is required");
const concurrency = Math.max(1, Number(process.env.SETTLEMENT_LOAD_CONCURRENCY || 20));
const timeoutMs = Math.max(100, Number(process.env.SETTLEMENT_LOAD_TIMEOUT_MS || 15000));
const body = process.env.SETTLEMENT_LOAD_BODY || "{}";
const origin = process.env.SETTLEMENT_LOAD_ORIGIN;
const cookie = process.env.SETTLEMENT_LOAD_COOKIE;
const headers = { "content-type": "application/json" };
if (origin) headers.origin = origin;
if (cookie) headers.cookie = cookie;
const latencies = [];
let success = 0, errors = 0;
const started = performance.now();
const worker = async () => {
  const t = performance.now();
  try {
    const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) success++; else errors++;
  } catch { errors++; }
  latencies.push(performance.now() - t);
};
await Promise.all(Array.from({ length: concurrency }, worker));
latencies.sort((a,b) => a-b);
const pct = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))] : 0;
const result = { url, concurrency, success, errors, elapsedMs: performance.now() - started, p50Ms: pct(.5), p95Ms: pct(.95), p99Ms: pct(.99) };
console.log(JSON.stringify(result, null, 2));
if (errors > 0) process.exitCode = 1;
